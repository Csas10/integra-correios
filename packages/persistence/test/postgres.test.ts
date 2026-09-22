import { describe, expect, it } from "vitest";
import {
  PostgresConfirmationOwnership,
  PostgresOperationalRepository,
  type QueryResult,
  type SqlPool,
  type SqlTransaction,
} from "../src/index.js";

class RecordingTransaction implements SqlTransaction {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;
  failOn?: string;

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (this.failOn && text.includes(this.failOn)) throw new Error("falha sintética");
    return { rows: [], rowCount: 1 };
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements SqlPool {
  readonly directCalls: { text: string; values: readonly unknown[] }[] = [];
  readonly transaction = new RecordingTransaction();
  result: QueryResult<Record<string, unknown>> = { rows: [], rowCount: 0 };

  async connect(): Promise<SqlTransaction> {
    return this.transaction;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.directCalls.push({ text, values });
    return this.result as QueryResult<Row>;
  }
}

const encrypted = {
  ciphertext: Uint8Array.from([1]),
  nonce: new Uint8Array(12),
  authTag: new Uint8Array(16),
  keyVersion: "test-v1",
};

const audit = {
  id: "50000000-0000-4000-8000-000000000001",
  aggregateType: "PROFISSIONAL",
  aggregateId: "10000000-0000-4000-8000-000000000001",
  type: "TESTE_SINTETICO",
  occurredAt: "2026-09-16T00:00:00.000Z",
  eventHash: "9".repeat(64),
};

describe("repositório PostgreSQL operacional", () => {
  it("grava profissional, snapshot e auditoria na mesma transação", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await repository.createProfessional({
      id: "10000000-0000-4000-8000-000000000001",
      origin: "PF",
      operationalCode: "SINTETICO-001",
      status: "CARTEIRA_IDENTIFICADA",
      document: {
        documentType: "CPF",
        fingerprint: "a".repeat(64),
        encrypted,
      },
      originalSnapshot: encrypted,
      auditEvent: audit,
    });

    expect(pool.transaction.calls[0]?.text).toBe("BEGIN");
    expect(pool.transaction.calls.map(({ text }) => text)).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO profissional"),
      expect.stringContaining("INSERT INTO snapshot_cadastral"),
      expect.stringContaining("INSERT INTO evento_auditoria"),
      "COMMIT",
    ]));
    expect(pool.transaction.released).toBe(true);
  });

  it("faz rollback e não confirma estado parcial", async () => {
    const pool = new RecordingPool();
    pool.transaction.failOn = "snapshot_cadastral";
    const repository = new PostgresOperationalRepository(pool);

    await expect(repository.createProfessional({
      id: "10000000-0000-4000-8000-000000000001",
      origin: "PF",
      operationalCode: "SINTETICO-002",
      status: "CARTEIRA_IDENTIFICADA",
      document: { documentType: "CPF", fingerprint: "a".repeat(64), encrypted },
      originalSnapshot: encrypted,
      auditEvent: audit,
    })).rejects.toThrow("falha sintética");

    expect(pool.transaction.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(pool.transaction.calls.map(({ text }) => text)).not.toContain("COMMIT");
  });

  it("rejeita profissional repetido antes de abrir a transação do lote", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    const item = {
      professionalId: "10000000-0000-4000-8000-000000000001",
      confirmationId: "30000000-0000-4000-8000-000000000001",
      communicationId: "40000000-0000-4000-8000-000000000001",
      outboxId: "60000000-0000-4000-8000-000000000001",
      tokenHash: "b".repeat(64),
      expiresAt: "2026-09-17T00:00:00.000Z",
      recipientFingerprint: "c".repeat(64),
      idempotencyKey: "pf-confirmation:test",
      encryptedPayload: encrypted,
      auditEvent: audit,
    };
    await expect(repository.enqueueCommunicationBatch({
      id: "20000000-0000-4000-8000-000000000001",
      code: "PF-MAIL-TESTE-001",
      origin: "PF",
      templateVersion: "pf-confirmation-v1",
      mode: "DRY_RUN",
      source: "INSTITUCIONAL_XLSX",
      createdBy: "teste",
      createdAt: "2026-09-16T00:00:00.000Z",
      auditEvent: audit,
      items: [item, { ...item, confirmationId: "30000000-0000-4000-8000-000000000002" }],
    })).rejects.toThrow("duplicado");
    expect(pool.transaction.calls).toHaveLength(0);
  });

  it("usa compare-and-set atômico para consumir uma confirmação", async () => {
    const pool = new RecordingPool();
    pool.result = {
      rowCount: 1,
      rows: [{
        id: "30000000-0000-4000-8000-000000000001",
        professional_id: "PF|SINTETICO-001",
        token_hash: "b".repeat(64),
        emitida_em: new Date("2026-09-16T00:00:00.000Z"),
        expira_em: new Date("2026-09-17T00:00:00.000Z"),
        consumida_em: new Date("2026-09-16T01:00:00.000Z"),
        template_versao: "pf-confirmation-v1",
        decisao: "CONFIRMAR",
      }],
    };
    const ownership = new PostgresConfirmationOwnership(pool);
    const consumed = await ownership.consumePending({
      confirmationId: "30000000-0000-4000-8000-000000000001",
      tokenHash: "b".repeat(64),
      usedAt: "2026-09-16T01:00:00.000Z",
      decision: "CONFIRMAR",
    });

    expect(consumed?.status).toBe("SUBMITTED");
    expect(pool.directCalls[0]?.text).toContain("status = 'PENDING'");
    expect(pool.directCalls[0]?.text).toContain("expira_em > $3");
    expect(pool.directCalls[0]?.text).toContain("UPDATE confirmacao");
  });

  it("reserva a outbox com SKIP LOCKED", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await repository.claimOutbox("worker-sintetico", 10, "2026-09-16T00:00:00.000Z");
    const claim = pool.transaction.calls.find(({ text }) => text.includes("SKIP LOCKED"));
    expect(claim?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim?.text).toContain("status = 'PROCESSING'");
  });
});
