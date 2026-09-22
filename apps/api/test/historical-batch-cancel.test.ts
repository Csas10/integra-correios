import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PostgresOperationalRepository,
  type SqlPool,
  type QueryResult,
  type SqlTransaction,
} from "@integra-correios/persistence";
import {
  CODIGO_LOTE_HISTORICO_DRY_RUN,
  validarCancelamentoLoteHistorico,
} from "../src/pilot.js";

// ---------------------------------------------------------------------------
// Cancelamento auditado do lote DRY_RUN histórico (PF-MAIL-PILOTO-MUB37G1H).
// Todas as fixtures são 100% sintéticas — nenhum dado institucional real.
// ---------------------------------------------------------------------------

class RecordingTransaction implements SqlTransaction {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;
  rowsFor: (text: string) => readonly Record<string, unknown>[] = () => [];

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    const rows = this.rowsFor(text);
    // UPDATE/INSERT afetam linhas sem retorná-las: rowCount sintético = 1.
    const rowCount = rows.length > 0 ? rows.length : /^\s*(UPDATE|INSERT)\b/i.test(text) ? 1 : 0;
    return { rows: rows as Row[], rowCount };
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements SqlPool {
  readonly transaction = new RecordingTransaction();
  rowsFor: (text: string) => readonly Record<string, unknown>[] = () => [];

  async connect(): Promise<SqlTransaction> {
    this.transaction.rowsFor = this.rowsFor;
    this.transaction.calls.length = 0;
    return this.transaction;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return { rows: this.rowsFor(text) as Row[], rowCount: this.rowsFor(text).length };
  }
}

function loteHistoricoRow(overrides: Record<string, unknown> = {}) {
  return {
    codigo: CODIGO_LOTE_HISTORICO_DRY_RUN,
    status: "ATIVO",
    modo: "DRY_RUN",
    criado_em: new Date("2026-09-20T10:00:00.000Z"),
    template_versao: "pf-pilot-crtba-v1",
    total: "3",
    ...overrides,
  };
}

function comandoBase(
  overrides: Partial<Parameters<PostgresOperationalRepository["cancelarLoteComunicacao"]>[0]> = {},
): Parameters<PostgresOperationalRepository["cancelarLoteComunicacao"]>[0] {
  return {
    batchId: randomUUID(),
    origin: "PF",
    expectedCode: CODIGO_LOTE_HISTORICO_DRY_RUN,
    realSendEnabled: false,
    actorId: "operador-sintetico",
    cancelledAt: "2026-09-22T12:00:00.000Z",
    auditEvent: {
      id: randomUUID(),
      aggregateType: "LOTE_COMUNICACAO",
      aggregateId: randomUUID(),
      type: "PF_LOTE_COMUNICACAO_CANCELADO",
      actorId: "operador-sintetico",
      occurredAt: "2026-09-22T12:00:00.000Z",
      metadata: { motivo: "HISTORICAL_DRY_RUN_ISOLATION", modo: "DRY_RUN" },
      eventHash: "a".repeat(64),
    },
    ...overrides,
  };
}

describe("cancelarLoteComunicacao — transição auditada ATIVO → CANCELADO", () => {
  it("cancela o lote exato ATIVO/DRY_RUN com CAS e um único evento auditado", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) return [loteHistoricoRow()];
      if (text.includes("FROM outbox_email o")) return [{ total: "0" }];
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    const command = comandoBase();
    const estado = await repository.cancelarLoteComunicacao(command);

    expect(estado.resultCode).toBe("CANCELLED");
    expect(estado.status).toBe("CANCELADO");
    expect(estado.totalItems).toBe(3);

    const textos = pool.transaction.calls.map(({ text }) => text);
    expect(textos.some((t) => t.includes("FOR UPDATE"))).toBe(true);
    expect(textos.filter((t) => t.includes("INSERT INTO evento_auditoria"))).toHaveLength(1);
    expect(textos.filter((t) => t.includes("UPDATE lote_comunicacao"))).toHaveLength(1);
    const update = pool.transaction.calls.find(({ text }) => text.includes("UPDATE lote_comunicacao"));
    expect(update?.text).toContain("status = 'CANCELADO'");
    expect(update?.text).toContain("status = 'ATIVO'"); // CAS
    // Nenhum DELETE em nenhuma tabela.
    expect(textos.some((t) => /\bDELETE\b/i.test(t))).toBe(false);
    // Nenhuma mutação em itens/comunicações/outbox/confirmações.
    expect(textos.some((t) => t.includes("UPDATE item_lote_comunicacao"))).toBe(false);
    expect(textos.some((t) => t.includes("UPDATE outbox_email"))).toBe(false);
    expect(textos.some((t) => t.includes("UPDATE confirmacao"))).toBe(false);
    expect(pool.transaction.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("bloqueia lote com código diferente do histórico", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) {
        return [loteHistoricoRow({ codigo: "CONTROLLED_GMAIL_TEST" })];
      }
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    await expect(repository.cancelarLoteComunicacao(comandoBase())).rejects.toThrow(
      "NOT_HISTORICAL_BATCH",
    );
  });

  it("bloqueia lote LIVE_PILOT", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) {
        return [loteHistoricoRow({ modo: "LIVE_PILOT" })];
      }
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    await expect(repository.cancelarLoteComunicacao(comandoBase())).rejects.toThrow(
      "MODE_NOT_DRY_RUN",
    );
  });

  it("bloqueia outbox pendente ou em processamento", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) return [loteHistoricoRow()];
      if (text.includes("FROM outbox_email o")) return [{ total: "2" }];
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    await expect(repository.cancelarLoteComunicacao(comandoBase())).rejects.toThrow(
      "OUTBOX_NOT_SETTLED",
    );
  });

  it("bloqueia REAL_SEND_ENABLED=true", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresOperationalRepository(pool);
    await expect(
      repository.cancelarLoteComunicacao(comandoBase({ realSendEnabled: true })),
    ).rejects.toThrow("REAL_SEND_ARMED");
    // Nenhuma transação sequer aberta — falha antes de tocar o banco.
    expect(pool.transaction.calls).toHaveLength(0);
  });

  it("idempotência: lote já CANCELADO retorna estado sem nova mutação nem evento", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) {
        return [loteHistoricoRow({ status: "CANCELADO" })];
      }
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    const estado = await repository.cancelarLoteComunicacao(comandoBase());
    expect(estado.resultCode).toBe("ALREADY_CANCELLED");
    expect(estado.status).toBe("CANCELADO");
    const textos = pool.transaction.calls.map(({ text }) => text);
    expect(textos.some((t) => t.includes("UPDATE lote_comunicacao"))).toBe(false);
    expect(textos.some((t) => t.includes("INSERT INTO evento_auditoria"))).toBe(false);
  });

  it("rejeita status PREPARACAO e CONCLUIDO", async () => {
    const pool = new RecordingPool();
    pool.rowsFor = (text) => {
      if (text.includes("FROM lote_comunicacao l")) {
        return [loteHistoricoRow({ status: "PREPARACAO" })];
      }
      return [];
    };
    const repository = new PostgresOperationalRepository(pool);
    await expect(repository.cancelarLoteComunicacao(comandoBase())).rejects.toThrow(
      "INVALID_STATE",
    );
  });
});

describe("validarCancelamentoLoteHistorico — pré-voo server-side", () => {
  it("aceita somente o lote histórico ATIVO/DRY_RUN", () => {
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: CODIGO_LOTE_HISTORICO_DRY_RUN,
        status: "ATIVO",
        modo: "DRY_RUN",
      }),
    ).not.toThrow();
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: CODIGO_LOTE_HISTORICO_DRY_RUN,
        status: "CANCELADO",
        modo: "DRY_RUN",
      }),
    ).not.toThrow();
  });

  it("rejeita qualquer outro lote (incl. CONTROLLED_GMAIL_TEST e LIVE_PILOT)", () => {
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: "CONTROLLED_GMAIL_TEST",
        status: "ATIVO",
        modo: "DRY_RUN",
      }),
    ).toThrow("NOT_HISTORICAL_BATCH");
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: CODIGO_LOTE_HISTORICO_DRY_RUN,
        status: "ATIVO",
        modo: "LIVE_PILOT",
      }),
    ).toThrow("MODE_NOT_DRY_RUN");
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: "PF-OUTRO-LOTE",
        status: "ATIVO",
        modo: "DRY_RUN",
      }),
    ).toThrow("NOT_HISTORICAL_BATCH");
    expect(() => validarCancelamentoLoteHistorico(null)).toThrow("NOT_HISTORICAL_BATCH");
    expect(() =>
      validarCancelamentoLoteHistorico({
        codigo: CODIGO_LOTE_HISTORICO_DRY_RUN,
        status: "CONCLUIDO",
        modo: "DRY_RUN",
      }),
    ).toThrow("INVALID_STATE");
  });
});
