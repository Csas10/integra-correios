import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Aes256GcmSecretBox } from "../src/crypto.js";
import { NodePostgresPool } from "../src/driver.js";
import { PostgresOperationalRepository } from "../src/postgres.js";

// Teste de integração real (PostgreSQL 16, fixtures exclusivamente sintéticas).
// Roda somente quando a suíte fornece DATABASE_URL — p.ex. na CI, após aplicar
// database/migrations/*.sql. O encadeamento do relatório usa:
//   DATABASE_URL=... npm test
const temBanco = Boolean(process.env.DATABASE_URL);
const d = temBanco ? describe : describe.skip;

const CHAVE = new Uint8Array(32).fill(7);
const caixa = new Aes256GcmSecretBox(CHAVE, "test-v1");

function bytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i) % 256);
}

function sintetico() {
  const id = randomUUID();
  const access = caixa.seal(`access-${id}`, "oauth:access");
  const refresh = caixa.seal(`refresh-${id}`, "oauth:refresh");
  const fingerprint = caixa.seal(id, "oauth:fingerprint").ciphertext.slice(0, 32);
  const fingerprintHex = Buffer.from(fingerprint)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64);
  return { id, access, refresh, fingerprintHex };
}

d("round-trip OAuth em PostgreSQL real (sintético)", () => {
  it("salva e recarrega a conexão com envelopes íntegros", async () => {
    const pool = new NodePostgresPool({
      connectionString: process.env.DATABASE_URL!,
    });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const { id, access, refresh, fingerprintHex } = sintetico();

      const audit = {
        id: randomUUID(),
        aggregateType: "OAUTH_CONNECTION",
        aggregateId: id,
        type: "OAUTH_SINTETICO",
        occurredAt: new Date().toISOString(),
        eventHash: "8".repeat(64) + randomUUID().replaceAll("-", "").slice(0, 0) + "7".repeat(0),
      };
      // hash_evento é UNIQUE — garanta 64 hex distintos por execução
      audit.eventHash = Array.from(
        { length: 64 },
        (_, i) => ((i + id.charCodeAt(i % id.length)) % 16).toString(16),
      ).join("");

      await repository.saveOauthConnection({
        connection: {
          id,
          provider: "GMAIL",
          accountFingerprint: fingerprintHex,
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
          accessToken: access,
          refreshToken: refresh,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        auditEvent: audit,
      });

      const carregada = await repository.loadGmailConnection(fingerprintHex);
      expect(carregada).toBeDefined();
      expect(carregada!.id).toBe(id);
      expect(carregada!.provider).toBe("GMAIL");
      expect(carregada!.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
      expect(carregada!.accessToken.keyVersion).toBe("test-v1");
      expect(carregada!.refreshToken?.keyVersion).toBe("test-v1");

      // A coluna chave_versao NÃO contém ciphertext do refresh (bug corrigido)
      const direto = await pool.query<{ chave_versao: string; refresh: Uint8Array | null }>(
        `SELECT chave_versao, refresh_token_ciphertext AS refresh
        FROM oauth_connection WHERE id = $1`,
        [id],
      );
      expect(direto.rows[0]?.chave_versao).toBe("test-v1");
      expect(Buffer.from(direto.rows[0]!.refresh!).equals(Buffer.from(refresh.ciphertext))).toBe(true);

      // Decifração round-trip com os envelopes persistidos
      const aberto = caixa.open(
        {
          ciphertext: carregada!.accessToken.ciphertext,
          nonce: carregada!.accessToken.nonce,
          authTag: carregada!.accessToken.authTag,
          keyVersion: carregada!.accessToken.keyVersion,
        },
        "oauth:access",
      );
      expect(new TextDecoder().decode(aberto)).toBe(`access-${id}`);

      // Upsert idempotente: mesmo id + mesmo fingerprint atualiza os tokens
      await expect(
        repository.saveOauthConnection({
          connection: {
            id,
            provider: "GMAIL",
            accountFingerprint: fingerprintHex,
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            accessToken: caixa.seal("novo-access", "oauth:access"),
            refreshToken: caixa.seal("novo-refresh", "oauth:refresh"),
          },
          auditEvent: { ...audit, id: randomUUID(), eventHash: "b".repeat(64) },
        }),
      ).resolves.toBeUndefined();

      const aposUpsert = await repository.loadGmailConnection(fingerprintHex);
      expect(aposUpsert?.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
      expect(aposUpsert?.id).toBe(id);

      // Identidade estrita: id NOVO com fingerprint EXISTENTE é rejeitado
      await expect(
        repository.saveOauthConnection({
          connection: {
            id: randomUUID(),
            provider: "GMAIL",
            accountFingerprint: fingerprintHex,
            scopes: ["https://www.googleapis.com/auth/gmail.send"],
            accessToken: caixa.seal("outro-access", "oauth:access"),
          },
          auditEvent: { ...audit, id: randomUUID(), eventHash: "c".repeat(64) },
        }),
      ).rejects.toThrow("Conflito entre identidade OAuth e fingerprint");

    } finally {
      await pool.close();
    }
  });

  it("F18 — binding OAuth one-time: consumo atômico, replay, expiração e corrida", async () => {
    const pool = new NodePostgresPool({
      connectionString: process.env.DATABASE_URL!,
    });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const agoraIso = new Date().toISOString();
      const futuro = new Date(Date.now() + 60_000).toISOString();
      const nonce = randomUUID();
      const nonceHash = createHash("sha256").update(nonce).digest("hex");
      const operadorHash = createHash("sha256").update("operador-pg").digest("hex");
      const verifierSealed = {
        ciphertext: new Uint8Array([1, 2, 3]),
        nonce: new Uint8Array([4, 5, 6]),
        authTag: new Uint8Array([7, 8, 9]),
        keyVersion: "v1",
      };

      await repository.registrarBindingOauthFlow({
        nonceHash,
        codeVerifier: verifierSealed,
        operadorHash,
        expiresAt: futuro,
      });

      // Primeira tentativa vence; segunda é replay.
      await expect(
        repository.consumirBindingOauthFlow({ nonceHash, operadorHash, now: agoraIso }),
      ).resolves.toMatchObject({ status: "CONSUMED" });
      await expect(
        repository.consumirBindingOauthFlow({ nonceHash, operadorHash, now: agoraIso }),
      ).resolves.toMatchObject({ status: "REPLAY" });

      // Binding expirado (registrado no passado) → EXPIRED.
      const expiradoHash = createHash("sha256").update(`${nonce}-expirado`).digest("hex");
      await repository.registrarBindingOauthFlow({
        nonceHash: expiradoHash,
        codeVerifier: verifierSealed,
        operadorHash,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await expect(
        repository.consumirBindingOauthFlow({ nonceHash: expiradoHash, operadorHash, now: agoraIso }),
      ).resolves.toMatchObject({ status: "EXPIRED" });

      // Nonce nunca registrado → MISSING.
      await expect(
        repository.consumirBindingOauthFlow({
          nonceHash: createHash("sha256").update(`${nonce}-fantasma`).digest("hex"),
          operadorHash,
          now: agoraIso,
        }),
      ).resolves.toMatchObject({ status: "MISSING" });

      // Sessão divergente (operador diferente do START) → SESSION_MISMATCH.
      const sessaoHash = createHash("sha256").update(`${nonce}-sessao`).digest("hex");
      await repository.registrarBindingOauthFlow({
        nonceHash: sessaoHash,
        codeVerifier: verifierSealed,
        operadorHash,
        expiresAt: futuro,
      });
      await expect(
        repository.consumirBindingOauthFlow({
          nonceHash: sessaoHash,
          operadorHash: createHash("sha256").update("outro-operador").digest("hex"),
          now: agoraIso,
        }),
      ).resolves.toMatchObject({ status: "SESSION_MISMATCH" });

      // Corrida: 8 consumos concorrentes do MESMO binding → exatamente 1 sucesso.
      const corridaHash = createHash("sha256").update(`${nonce}-corrida`).digest("hex");
      await repository.registrarBindingOauthFlow({
        nonceHash: corridaHash,
        codeVerifier: verifierSealed,
        operadorHash,
        expiresAt: futuro,
      });
      const resultados = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.consumirBindingOauthFlow({ nonceHash: corridaHash, operadorHash, now: agoraIso }),
        ),
      );
      expect(resultados.filter((r) => r.status === "CONSUMED")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "REPLAY")).toHaveLength(7);
    } finally {
      await pool.close();
    }
  });
});
