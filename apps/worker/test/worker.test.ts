import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DryRunMailGateway } from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  NodePostgresPool,
  PostgresOperationalRepository,
} from "@integra-correios/persistence";
import {
  criarGatewayDoAmbiente,
  processarOutboxUmaVez,
  executarWorkerUmaVez,
  sondarDatabase,
} from "../src/outbox.js";
import { avaliarReadiness, workerPodeExecutar } from "../src/readiness.js";

// Massa 100% sintética; sem rede, sem Gmail real, sem PII.

const envPronto = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://placeholder",
  // Mesma key de `caixa` abaixo — o motor abre payloads com esta chave.
  DATA_ENCRYPTION_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(11)).toString("base64"),
  DOCUMENT_FINGERPRINT_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(2)).toString("base64"),
  DATA_ENCRYPTION_KEY_VERSION: "v1",
  PILOT_MODE: "true",
  PILOT_MAX_RECIPIENTS: "5",
  REAL_SEND_ENABLED: "false",
};

function hash64(seed: string): string {
  return Array.from(
    { length: 64 },
    (_, i) => ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16),
  ).join("");
}

const caixa = new Aes256GcmSecretBox(new Uint8Array(32).fill(11), "v1");
const fingerprinter = new HmacSha256Fingerprinter(new Uint8Array(32).fill(13));

describe("readiness", () => {
  it("sem DATABASE_URL: database BLOCKED_EXTERNAL, modo PREFLIGHT, worker DISABLED sem PILOT_MODE", async () => {
    const report = await avaliarReadiness(
      { REAL_SEND_ENABLED: "false" },
      async () => false,
    );
    expect(report.database.status).toBe("BLOCKED_EXTERNAL");
    expect(report.executionMode).toBe("PREFLIGHT");
    expect(report.worker.status).toBe("DISABLED");
    expect(report.ppn.status).toBe("DISABLED");
    expect(report.realSend.status).toBe("DISABLED");
    // Nenhum valor de configuração vaza no relatório.
    const serializado = JSON.stringify(report);
    expect(serializado).not.toContain("postgres");
    expect(serializado).not.toContain("base64");
  });

  it("com requisitos internos READY: modo DRY_RUN e worker pronto (PILOT_MODE=true)", async () => {
    const report = await avaliarReadiness(envPronto, async () => true);
    expect(report.database.status).toBe("READY");
    expect(report.cryptography.status).toBe("READY");
    expect(report.persistence.status).toBe("READY");
    expect(report.worker.status).toBe("READY");
    expect(report.executionMode).toBe("DRY_RUN");
    expect(workerPodeExecutar(report).ok).toBe(true);
  });

  it("worker recusa execução sem requisitos internos (fail-closed)", async () => {
    const report = await avaliarReadiness({ PILOT_MODE: "true" }, async () => false);
    const veredito = workerPodeExecutar(report);
    expect(veredito.ok).toBe(false);
    expect(veredito.motivo).toMatch(/DATABASE|CRYPTOGRAPHY/);
  });

  it("sondarDatabase sem DSN é falso e nunca lança", async () => {
    expect(await sondarDatabase({})).toBe(false);
    expect(await sondarDatabase({ DATABASE_URL: "postgresql://inexistente.invalid/db" })).toBe(false);
  });
});

describe("gateway do ambiente", () => {
  it("DRY_RUN sempre sintético, mesmo com REAL_SEND_ENABLED=true", () => {
    expect(criarGatewayDoAmbiente({ REAL_SEND_ENABLED: "true" }, true)).toBeInstanceOf(DryRunMailGateway);
  });

  it("REAL_SEND_ENABLED=false → sintético (GATE 1 fechado)", () => {
    expect(criarGatewayDoAmbiente({ REAL_SEND_ENABLED: "false" }, false)).toBeInstanceOf(DryRunMailGateway);
  });

  it("REAL_SEND_ENABLED=true + provider GMAIL → gateway real (exige ainda GATE 2 do claim)", () => {
    const gateway = criarGatewayDoAmbiente({ REAL_SEND_ENABLED: "true", MAIL_PROVIDER: "gmail" }, false);
    expect(gateway).not.toBeInstanceOf(DryRunMailGateway);
  });
});

const temBanco = Boolean(process.env.DATABASE_URL);
const d = temBanco ? describe : describe.skip;

d("executarWorkerUmaVez (motor completo, PostgreSQL real)", () => {
  it("DRY_RUN processa lote ATIVO com gateway sintético e persiste receipt/auditoria", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `WK-${randomUUID().slice(0, 8).toUpperCase()}`;
      const agora = new Date().toISOString();

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "APTO_CONTATO",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-wk", `${codigo}:sintetico`),
          encrypted: caixa.seal("00000000000", "documento:cpf"),
        },
        originalSnapshot: caixa.seal(
          JSON.stringify({
            nome: "Profissional Sintetico",
            email: "sintetico@exemplo.test",
            telefone: "00000000000",
            enderecoOrigem: "Rua de Teste, 100 - Centro - Sao Paulo/SP - 01001000",
          }),
          "snapshot:original",
        ),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      const loteId = randomUUID();
      const outboxId = randomUUID();
      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-WK-${codigo}`,
        origin: "PF",
        templateVersion: "pf-pilot-crtba-v1",
        mode: "DRY_RUN",
        createdBy: "worker-test",
        createdAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId: randomUUID(),
            communicationId: randomUUID(),
            outboxId,
            tokenHash: hash64("token-wk"),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            recipientFingerprint: hash64("email-wk"),
            idempotencyKey: `pf-pilot:wk:${outboxId}`,
            encryptedPayload: caixa.seal(
              JSON.stringify({
                professionalId: profissionalId,
                confirmationId: randomUUID(),
                confirmationBaseUrl: "https://app.exemplo.test",
                nome: "Profissional Sintetico",
                destinatario: "sintetico@exemplo.test",
                enderecoApresentado: "Rua de Teste, 100",
                telefone: "00000000000",
              }),
              "outbox:email",
            ),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: agora,
              metadata: {},
              eventHash: hash64(outboxId),
            },
          },
        ],
      });

      // Antes da liberação: nada é processado (GATE 2).
      const bloqueado = await executarWorkerUmaVez({
        workerId: "worker-wk-pre",
        env: envPronto,
      });
      expect(
        bloqueado.resultado?.processados === 0 || bloqueado.motivo !== undefined,
      ).toBe(true);

      // Liberação humana (GATE 2 aberto).
      await repository.ativarLoteComunicacao({
        batchId: loteId,
        origin: "PF",
        actorId: "worker-test",
        activatedAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_ATIVADO_V0",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(`ativ:${loteId}`),
        },
      });

      // Motor completo: claim → render → gateway sintético → receipt → auditoria.
      const { resultado } = await executarWorkerUmaVez({
        workerId: "worker-wk",
        env: envPronto,
      });
      expect(resultado).toBeDefined();
      expect(resultado!.modo).toBe("DRY_RUN");
      expect(resultado!.enviados).toBeGreaterThanOrEqual(1);

      // Persistência do resultado: outbox SENT + comunicação ACCEPTED.
      const estado = await pool.query<{ outbox: string; comunicacao: string }>(
        `SELECT o.status AS outbox, c.status AS comunicacao
        FROM outbox_email o JOIN comunicacao c ON c.id = o.comunicacao_id
        WHERE o.id = $1`,
        [outboxId],
      );
      expect(estado.rows[0]).toEqual({ outbox: "SENT", comunicacao: "ACCEPTED" });
    } finally {
      await pool.close();
    }
  });

  it("processarOutboxUmaVez com gateway que falha registra FAILED + código sanitizado", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `WF-${randomUUID().slice(0, 8).toUpperCase()}`;
      const agora = new Date().toISOString();
      const caixaLocal = new Aes256GcmSecretBox(new Uint8Array(32).fill(21), "v1");

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "APTO_CONTATO",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-wf", `${codigo}:sintetico`),
          encrypted: caixaLocal.seal("00000000000", "documento:cpf"),
        },
        originalSnapshot: caixaLocal.seal(JSON.stringify({ nome: "Sintetico" }), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      const loteId = randomUUID();
      const outboxId = randomUUID();
      const communicationId = randomUUID();
      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-WF-${codigo}`,
        origin: "PF",
        templateVersion: "pf-pilot-crtba-v1",
        mode: "DRY_RUN",
        createdBy: "worker-test",
        createdAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId: randomUUID(),
            communicationId,
            outboxId,
            tokenHash: hash64("token-wf"),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            recipientFingerprint: hash64("email-wf"),
            idempotencyKey: `pf-pilot:wf:${outboxId}`,
            // Payload inválido (não-JSON) → falha de RENDER (artefato), nunca
            // do provider: código RENDER_PAYLOAD_ERROR, sem retry inútil.
            encryptedPayload: caixaLocal.seal("payload-nao-json", "outbox:email"),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: agora,
              metadata: {},
              eventHash: hash64(outboxId),
            },
          },
        ],
      });
      await repository.ativarLoteComunicacao({
        batchId: loteId,
        origin: "PF",
        actorId: "worker-test",
        activatedAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_ATIVADO_V0",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(`ativ:${loteId}`),
        },
      });

      const gatewayFalho = {
        send: async () => {
          throw new Error("REAL_SEND_ENABLED=false");
        },
        getStatus: async () => {
          throw new Error("n/a");
        },
      };
      const resultado = await processarOutboxUmaVez(
        "worker-wf",
        pool,
        gatewayFalho,
        caixaLocal,
        repository,
        new Date(),
      );
      // Payload inválido → falha de RENDER (artefato), nunca do provider:
      // código RENDER_PAYLOAD_ERROR, sem retry inútil.
      expect(resultado.falhas).toBeGreaterThanOrEqual(1);
      expect(resultado.codigosErro).toContain("RENDER_PAYLOAD_ERROR");
    } finally {
      await pool.close();
    }
  });
});
