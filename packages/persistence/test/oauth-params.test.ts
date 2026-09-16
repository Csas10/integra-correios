import { describe, expect, it } from "vitest";
import {
  PostgresOperationalRepository,
  type QueryResult,
  type SqlPool,
  type SqlTransaction,
} from "../src/index.js";
import type { SaveOauthConnectionCommand } from "../src/contracts.js";

class RecordingTransaction implements SqlTransaction {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    return {
      rows: [{ id: "70000000-0000-4000-8000-000000000001" }],
      rowCount: 1,
    } as unknown as QueryResult<Row>;
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements SqlPool {
  readonly transaction = new RecordingTransaction();

  async connect(): Promise<SqlTransaction> {
    return this.transaction;
  }

  async query<Row extends Record<string, unknown>>(): Promise<QueryResult<Row>> {
    return { rows: [], rowCount: 0 };
  }
}

const audit = {
  id: "50000000-0000-4000-8000-000000000009",
  aggregateType: "OAUTH_CONNECTION",
  aggregateId: "70000000-0000-4000-8000-000000000001",
  type: "OAUTH_SINTETICO",
  occurredAt: "2026-09-16T00:00:00.000Z",
  eventHash: "8".repeat(64),
};

function bytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i) % 256);
}

const access = {
  ciphertext: bytes(1, 32),
  nonce: bytes(2, 12),
  authTag: bytes(3, 16),
  keyVersion: "v1",
};
const refresh = {
  ciphertext: bytes(4, 48),
  nonce: bytes(5, 12),
  authTag: bytes(6, 16),
  keyVersion: "v1",
};

function comando(
  overrides?: Partial<Omit<SaveOauthConnectionCommand["connection"], "refreshToken">> & {
    refreshToken?: SaveOauthConnectionCommand["connection"]["refreshToken"];
  },
): SaveOauthConnectionCommand {
  const { refreshToken = refresh, ...resto } = overrides ?? {};
  return {
    connection: {
      id: "70000000-0000-4000-8000-000000000001",
      provider: "GMAIL",
      accountFingerprint: "a".repeat(64),
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      accessToken: access,
      expiresAt: "2026-09-16T01:00:00.000Z",
      ...resto,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    },
    auditEvent: audit,
  };
}

const COLUNAS = [
  "access_token_ciphertext",
  "access_token_nonce",
  "access_token_auth_tag",
  "refresh_token_ciphertext",
  "refresh_token_nonce",
  "refresh_token_auth_tag",
  "chave_versao",
  "expira_em",
] as const;

describe("saveOauthConnection — correspondência placeholders × colunas", () => {
  it("gera 11 placeholders e 11 valores, sem keyVersion deslocado", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await repository.saveOauthConnection(comando());

    const call = pool.transaction.calls.find(({ text }) => text.includes("INSERT INTO oauth_connection"));
    expect(call).toBeDefined();

    const placeholders = (call!.text.match(/\$\d+/g) ?? []).map((p) => Number(p.slice(1)));
    expect(placeholders).toHaveLength(11);
    expect(placeholders).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(call!.values).toHaveLength(11);
  });

  it("vincula explicitamente cada campo cifrado à coluna correta", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await repository.saveOauthConnection(comando());

    const call = pool.transaction.calls.find(({ text }) => text.includes("INSERT INTO oauth_connection"))!;
    const valores = call.values as unknown[];

    COLUNAS.forEach((coluna, i) => {
      expect(call.text).toContain(`${coluna}`);
      void coluna;
      const valor = valores[i + 3]; // pula $1 id, $2 fingerprint, $3 scopes
      void valor;
    });

    // $4..$6 = envelope do access token (na ordem exata)
    expect(Buffer.from(valores[3] as Uint8Array).equals(Buffer.from(access.ciphertext))).toBe(true);
    expect(Buffer.from(valores[4] as Uint8Array).equals(Buffer.from(access.nonce))).toBe(true);
    expect(Buffer.from(valores[5] as Uint8Array).equals(Buffer.from(access.authTag))).toBe(true);

    // $7..$9 = envelope do refresh token
    expect(Buffer.from(valores[6] as Uint8Array).equals(Buffer.from(refresh.ciphertext))).toBe(true);
    expect(Buffer.from(valores[7] as Uint8Array).equals(Buffer.from(refresh.nonce))).toBe(true);
    expect(Buffer.from(valores[8] as Uint8Array).equals(Buffer.from(refresh.authTag))).toBe(true);

    // $10 = chave_versao NÃO é bytes e NÃO é o ciphertext do refresh
    expect(valores[9]).toBe("v1");
    expect(Buffer.isBuffer(valores[9])).toBe(false);

    // $11 = expira_em
    expect(valores[10]).toBe("2026-09-16T01:00:00.000Z");
  });

  it("mantém correspondência sem refresh token (NULLs explícitos)", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    const cmd = comando({ refreshToken: undefined });
    const semRefresh = { ...cmd, connection: { ...cmd.connection } };
    delete (semRefresh.connection as { refreshToken?: unknown }).refreshToken;
    await repository.saveOauthConnection(semRefresh);

    const call = pool.transaction.calls.find(({ text }) => text.includes("INSERT INTO oauth_connection"))!;
    expect(call.values).toHaveLength(11);
    expect(call.values[6]).toBeNull();
    expect(call.values[7]).toBeNull();
    expect(call.values[8]).toBeNull();
    expect(call.values[9]).toBe("v1");
  });

  it("rejecta tokens com versões de chave divergentes", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await expect(
      repository.saveOauthConnection(
        comando({ refreshToken: { ...refresh, keyVersion: "v2" } }),
      ),
    ).rejects.toThrow("mesma versão de chave");
  });
});
