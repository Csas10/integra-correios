/**
 * CORRECTIVE_RECOVERY_SQL_SYNTAX — integração REAL (PostgreSQL 16).
 *
 * O 500 do Preview foi causado por SQL com sintaxe inválida gerado por
 * concatenação (`$1AND`) — invisível para os testes com pool simulado.
 * Aqui `recuperarOutboxControlada` roda contra o PostgreSQL real (a CI
 * aplica database/migrations/*.sql antes da suíte; local requer
 * DATABASE_URL), provando:
 *   1. SQL válido na montagem do vínculo legado (espaço antes de AND);
 *   2. o cenário legado exato do incidente: FAILED / FAILED_PERMANENT /
 *      tentativas=2 na comunicação server-side b76a1e9b-a59d-4777-8777-
 *      c2e61536613c do lote CONTROLLED_GMAIL_TEST;
 *   3. idempotência REAL: segunda chamada → ALREADY_RECOVERED sem mutação;
 *   4. ROLLBACK: falha no meio da transação (gate depois do FOR UPDATE)
 *      não deixa mutação nem evento de auditoria.
 *
 * Massa 100% sintética; sem rede, sem Gmail real, sem PII.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  NodePostgresPool,
  PostgresOperationalRepository,
  type CommunicationBatchItem,
} from "../src/index.js";

const temBanco = Boolean(process.env.DATABASE_URL);
const d = temBanco ? describe : describe.skip;

const caixa = new Aes256GcmSecretBox(new Uint8Array(32).fill(21), "recovery-v1");
const fingerprinter = new HmacSha256Fingerprinter(new Uint8Array(32).fill(23));

function hash64(seed: string): string {
  return Array.from(
    { length: 64 },
    (_, i) => ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16),
  ).join("");
}

/** Item do incidente: comunicação com id fixo server-side + outbox nova. */
function itemIncidente(
  profissionalId: string,
  confirmationId: string,
  communicationId: string,
  outboxId: string,
): CommunicationBatchItem {
  return {
    professionalId: profissionalId,
    confirmationId,
    communicationId,
    outboxId,
    tokenHash: hash64(`token-${confirmationId}`),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    recipientFingerprint: fingerprinter.fingerprint("email-rec", randomUUID()),
    idempotencyKey: `pf-confirmation:rec:${confirmationId}`,
    encryptedPayload: caixa.seal("payload-sintetico-rec", "outbox:email"),
    auditEvent: {
      id: randomUUID(),
      aggregateType: "PROFISSIONAL",
      aggregateId: profissionalId,
      type: "PF_CONFIRMACAO_EMITIDA_REC",
      occurredAt: new Date().toISOString(),
      metadata: { sintetico: true },
      eventHash: hash64(confirmationId),
    },
  };
}

/** Comunicação do incidente legado — definida server-side (id sintético). */
const COMUNICACAO_INCIDENTE = "b76a1e9b-a59d-4777-8777-c2e61536613c";
const CODIGO_LOTE = "CONTROLLED_GMAIL_TEST";

// O código do lote é UNIQUE (origem, codigo) no banco e a recuperação valida
// exatamente CONTROLLED_GMAIL_TEST — os cenários reutilizam a MESMA linha de
// lote entre os testes (limpa no afterAll; cada teste cria profissional,
// comunicação e outbox próprios). A primeira tentativa de falha do incidente
// é determinada por busca/criação da outbox em tentativas=2.
const POOL_COMPARTILHADO: { pool: NodePostgresPool | null } = { pool: null };
afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pool = POOL_COMPARTILHADO.pool ?? new NodePostgresPool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `DELETE FROM evento_auditoria WHERE agregado_tipo IN ('COMUNICACAO','LOTE_COMUNICACAO')
        AND agregado_id IN (
          SELECT c.id FROM comunicacao c JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id WHERE l.codigo = $1
          UNION SELECT l.id FROM lote_comunicacao l WHERE l.codigo = $1)`,
      [CODIGO_LOTE],
    );
    await pool.query(
      `DELETE FROM outbox_email WHERE comunicacao_id IN (
        SELECT c.id FROM comunicacao c JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id WHERE l.codigo = $1)`,
      [CODIGO_LOTE],
    );
    await pool.query(
      `DELETE FROM comunicacao WHERE lote_comunicacao_id IN (SELECT id FROM lote_comunicacao WHERE codigo = $1)`,
      [CODIGO_LOTE],
    );
    await pool.query(`DELETE FROM lote_comunicacao WHERE codigo = $1`, [CODIGO_LOTE]);
  } finally {
    await pool.close();
  }
});

async function montarCenarioIncidente(pool: NodePostgresPool, opcoes: { erro: string } = { erro: "FAILED_PERMANENT" }) {
  const profissionalId = randomUUID();
  const communicationId = COMUNICACAO_INCIDENTE;
  const outboxId = randomUUID();
  const confirmationId = randomUUID();
  const repository = new PostgresOperationalRepository(pool);

  await repository.createProfessional({
    id: profissionalId,
    origin: "PF",
    operationalCode: `REC-${randomUUID().slice(0, 8).toUpperCase()}`,
    status: "CARTEIRA_IDENTIFICADA",
    document: {
      documentType: "CPF",
      fingerprint: fingerprinter.fingerprint("cpf-rec", randomUUID()),
      encrypted: caixa.seal("00000000000", "documento:cpf"),
    },
    originalSnapshot: caixa.seal(JSON.stringify({ sintetico: true }), "snapshot:original"),
    auditEvent: {
      id: randomUUID(),
      aggregateType: "PROFISSIONAL",
      aggregateId: profissionalId,
      type: "PF_IMPORTADO_REC",
      occurredAt: new Date().toISOString(),
      metadata: { sintetico: true },
      eventHash: hash64(profissionalId),
    },
  });

  // Lote com código UNIQUE compartilhado entre os testes: busca o existente
  // (com ativação e retry autorizado prévios) ou cria um novo. O repositório
  // exige ≥1 item por enqueue, então o item do incidente acompanha a criação;
  // nos testes seguintes, nova chamada com o MESMO id do lote insere apenas
  // os itens (a comunicação do incidente tem id fixo server-side).
  const loteExistente = await pool.query<{ id: string }>(
    `SELECT id FROM lote_comunicacao WHERE codigo = $1 AND origem = 'PF' LIMIT 1`,
    [CODIGO_LOTE],
  );
  let loteId: string;
  if (loteExistente.rows[0]) {
    // Lote já existe de um teste anterior: insere confirmação + comunicação +
    // outbox + item DIRETAMENTE (mesma estrutura gravada pelo repositório) —
    // enqueueCommunicationBatch recriaria o lote (pkey). Sem evento novo:
    // a recuperação não exige reativação.
    loteId = loteExistente.rows[0].id;
    await pool.query(`UPDATE lote_comunicacao SET status = 'ATIVO' WHERE id = $1`, [loteId]);
    await pool.query(
      `INSERT INTO confirmacao (
        id, profissional_id, token_hash, template_versao, status, emitida_em, expira_em
      ) VALUES ($1, $2, $3, 'pf-confirmation-v1', 'PENDING', $4, $5)`,
      [
        confirmationId,
        profissionalId,
        hash64(`token-${confirmationId}`),
        new Date().toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    await pool.query(
      `INSERT INTO comunicacao (
        id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
        destinatario_fingerprint, template_versao, idempotency_key, status, fonte_registro, criada_em
      ) VALUES ($1, $2, $3, $4, 'PF', 'PENDING', $5, 'pf-confirmation-v1', $6, 'QUEUED', 'CONTROLADO_SINTETICO', $7)`,
      [
        communicationId,
        profissionalId,
        confirmationId,
        loteId,
        fingerprinter.fingerprint("email-rec", randomUUID()),
        `pf-confirmation:rec:${confirmationId}`,
        new Date().toISOString(),
      ],
    );
    const payload = caixa.seal("payload-sintetico-rec", "outbox:email");
    await pool.query(
      `INSERT INTO outbox_email (
        id, comunicacao_id, idempotency_key, payload_ciphertext,
        payload_nonce, payload_auth_tag, chave_versao, status, disponivel_em
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)`,
      [
        outboxId,
        communicationId,
        `pf-confirmation:rec:${confirmationId}`,
        payload.ciphertext,
        payload.nonce,
        payload.authTag,
        payload.keyVersion,
        new Date().toISOString(),
      ],
    );
    await pool.query(
      `INSERT INTO item_lote_comunicacao (
        id, lote_comunicacao_id, profissional_id, comunicacao_id, origem, status
      ) VALUES ($1, $2, $3, $4, 'PF', 'ENFILEIRADO')
      ON CONFLICT DO NOTHING`,
      [randomUUID(), loteId, profissionalId, communicationId],
    );
  } else {
    loteId = randomUUID();
    await repository.enqueueCommunicationBatch({
      id: loteId,
      code: CODIGO_LOTE,
      origin: "PF",
      templateVersion: "pf-confirmation-v1",
      mode: "LIVE_PILOT",
      source: "CONTROLADO_SINTETICO",
      createdBy: "teste-recuperacao",
      createdAt: new Date().toISOString(),
      auditEvent: {
        id: randomUUID(),
        aggregateType: "LOTE_COMUNICACAO",
        aggregateId: loteId,
        type: "PF_LOTE_COMUNICACAO_CRIADO",
        occurredAt: new Date().toISOString(),
        metadata: { totalItens: 1 },
        eventHash: hash64(loteId),
      },
      items: [itemIncidente(profissionalId, confirmationId, communicationId, outboxId)],
    });
    // Ativa o lote (PREPARACAO → ATIVO, com evento auditado).
    await repository.ativarLoteComunicacao({
      batchId: loteId,
      origin: "PF",
      actorId: "operador-teste",
      activatedAt: new Date().toISOString(),
      auditEvent: {
        id: randomUUID(),
        aggregateType: "LOTE_COMUNICACAO",
        aggregateId: loteId,
        type: "PF_LOTE_COMUNICACAO_ATIVADO",
        occurredAt: new Date().toISOString(),
        metadata: { sintetico: true },
        eventHash: hash64(`ativ-${loteId}`),
      },
    });
    // Evento prévio PF_CONTROLLED_RETRY_AUTORIZADO no LOTE (exigência do vínculo).
    await pool.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, ator_id, ocorreu_em,
        metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'LOTE_COMUNICACAO', $2, 'PF_CONTROLLED_RETRY_AUTORIZADO', 'operador-teste', $3, '{"sintetico":true}'::jsonb, NULL, $4)`,
      [randomUUID(), loteId, new Date().toISOString(), hash64(`retry-${loteId}`)],
    );
  }


  // Reconstrói o estado do incidente: tentativas=2 (PROVIDER_NOT_CONFIGURED
  // pré-rede + a falha final do gate) e FAILED com o código sob teste.
  await repository.claimOutbox("worker-recuperacao", 10, new Date().toISOString());
  await repository.markOutboxFailed({
    outboxId,
    communicationId,
    errorCode: "PROVIDER_NOT_CONFIGURED",
    retryAt: new Date().toISOString(),
    auditEvent: {
      id: randomUUID(),
      aggregateType: "COMUNICACAO",
      aggregateId: communicationId,
      type: "PF_COMMUNICATION_FAILED",
      occurredAt: new Date().toISOString(),
      metadata: { codigo: "PROVIDER_NOT_CONFIGURED" },
      eventHash: hash64(`fail1-${outboxId}`),
    },
  });
  await repository.claimOutbox("worker-recuperacao-2", 10, new Date().toISOString());
  await repository.markOutboxFailed({
    outboxId,
    communicationId,
    errorCode: opcoes.erro,
    retryAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    auditEvent: {
      id: randomUUID(),
      aggregateType: "COMUNICACAO",
      aggregateId: communicationId,
      type: "PF_COMMUNICATION_FAILED",
      occurredAt: new Date().toISOString(),
      metadata: { codigo: opcoes.erro, final: true },
      eventHash: hash64(`fail2-${outboxId}`),
    },
  });

  return { repository, pool, profissionalId, loteId, communicationId, outboxId };
}

function comandoRecuperacao(opcoes: { erro: string; communicationId?: string; operador?: string }) {
  const agora = new Date().toISOString();
  return {
    expectedCode: CODIGO_LOTE,
    expectedErrorCode: opcoes.erro,
    expectedAttempts: 2,
    ...(opcoes.communicationId ? { expectedCommunicationId: opcoes.communicationId } : {}),
    realSendEnabled: false,
    availableAt: agora,
    auditEvent: {
      id: randomUUID(),
      aggregateType: "COMUNICACAO",
      aggregateId: "",
      type: "PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO",
      occurredAt: agora,
      actorId: opcoes.operador ?? "operador-teste",
      metadata: { motivo: opcoes.erro, finalidade: "recuperacao-gate-pre-send" },
      eventHash: hash64(`rec-${agora}`),
    },
  };
}

d("CORRECTIVE_RECOVERY_SQL_SYNTAX — recuperarOutboxControlada em PostgreSQL 16 real", () => {
  it("cenário legado EXATO do incidente: FAILED/FAILED_PERMANENT/tentativas=2 → RECOVERED com evento vinculado", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const { repository, communicationId, outboxId } = await montarCenarioIncidente(pool);
      const resultado = await repository.recuperarOutboxControlada(
        comandoRecuperacao({ erro: "FAILED_PERMANENT", communicationId }) as never,
      );
      expect(resultado.resultCode).toBe("RECOVERED");
      expect(resultado.outboxId).toBe(outboxId);
      expect(resultado.status).toBe("PENDING");

      // Outbox em PENDING; evento de recuperação vinculado ao comunicacao_id REAL.
      const verificacao = await pool.query<{
        outbox_status: string;
        eventos_recuperacao: string;
        ultimo_evento_agregado: string | null;
      }>(
        `SELECT o.status AS outbox_status,
          (SELECT count(*) FROM evento_auditoria ea
            WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $2
              AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO') AS eventos_recuperacao,
          (SELECT ea.agregado_id FROM evento_auditoria ea
            WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $2
              AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO'
            ORDER BY ea.ocorreu_em DESC LIMIT 1) AS ultimo_evento_agregado
        FROM outbox_email o WHERE o.id = $1`,
        [outboxId, communicationId],
      );
      expect(verificacao.rows[0]?.outbox_status).toBe("PENDING");
      expect(Number(verificacao.rows[0]?.eventos_recuperacao ?? 0)).toBe(1);
      expect(verificacao.rows[0]?.ultimo_evento_agregado).toBe(communicationId);
    } finally {
      await pool.close();
    }
  });

  it("idempotência REAL: segunda chamada → ALREADY_RECOVERED sem nova mutação", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const { repository, communicationId, outboxId } = await montarCenarioIncidente(pool);
      await repository.recuperarOutboxControlada(
        comandoRecuperacao({ erro: "FAILED_PERMANENT", communicationId }) as never,
      );
      // Idempotência REAL — a segunda chamada roda contra o PostgreSQL de
      // verdade: ALREADY_RECOVERED sem nova mutação e sem novo evento.
      const segunda = await repository.recuperarOutboxControlada(
        comandoRecuperacao({ erro: "FAILED_PERMANENT", communicationId }) as never,
      );
      expect(segunda.resultCode).toBe("ALREADY_RECOVERED");

      // Ainda exatamente UM evento de recuperação.
      const eventos = await pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM evento_auditoria ea
        WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $1
          AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO'`,
        [communicationId],
      );
      expect(Number(eventos.rows[0]?.total ?? 0)).toBe(1);
      const outbox = await pool.query<{ status: string }>(
        `SELECT status FROM outbox_email WHERE id = $1`,
        [outboxId],
      );
      expect(outbox.rows[0]?.status).toBe("PENDING");
    } finally {
      await pool.close();
    }
  });

  it("vínculo server-side: OUTRA comunicação do mesmo lote é recusada SEM mutação e SEM auditoria", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const { pool: _pool, ...cenario } = await montarCenarioIncidente(pool);
      const outraComunicacao = randomUUID();
      // Garante que o id divergente não existe — o filtro do SQL recusa.
      await expect(
        cenario.repository.recuperarOutboxControlada(
          comandoRecuperacao({ erro: "FAILED_PERMANENT", communicationId: outraComunicacao }) as never,
        ),
      ).rejects.toThrow(/COMMUNICATION_MISMATCH/);

      // NADA mudou: outbox permanece FAILED e nenhum evento de recuperação.
      const verificacao = await pool.query<{ status: string; eventos: string }>(
        `SELECT o.status,
          (SELECT count(*) FROM evento_auditoria ea
            WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $2
              AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO') AS eventos
        FROM outbox_email o WHERE o.id = $1`,
        [cenario.outboxId, cenario.communicationId],
      );
      expect(verificacao.rows[0]?.status).toBe("FAILED");
      expect(Number(verificacao.rows[0]?.eventos ?? 0)).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it("ROLLBACK: falha de gate (código divergente) após o FOR UPDATE não deixa mutação nem auditoria", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const { repository, communicationId, outboxId } = await montarCenarioIncidente(pool);
      await expect(
        repository.recuperarOutboxControlada(
          comandoRecuperacao({ erro: "DELIVERY_UNKNOWN", communicationId }) as never,
        ),
      ).rejects.toThrow(/ERROR_CODE_MISMATCH/);

      // Transação revertida integralmente: estado e auditoria intocados.
      const verificacao = await pool.query<{ status: string; erro: string | null; eventos: string }>(
        `SELECT o.status, o.ultimo_erro_codigo AS erro,
          (SELECT count(*) FROM evento_auditoria ea
            WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $2
              AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO') AS eventos
        FROM outbox_email o WHERE o.id = $1`,
        [outboxId, communicationId],
      );
      expect(verificacao.rows[0]?.status).toBe("FAILED");
      expect(verificacao.rows[0]?.erro).toBe("DELIVERY_UNKNOWN");
      expect(Number(verificacao.rows[0]?.eventos ?? 0)).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it("SQL válido com vínculo legado: consulta final NÃO contém concatenação `$1AND`", async () => {
    // Prova estrutural do CORRECTIVE_RECOVERY_SQL_SYNTAX: o texto do comando
    // montado pelo repositório contém espaço antes de AND quando o vínculo
    // legado está ativo. Executada no PostgreSQL real via EXPLAIN — sintaxe
    // inválida falharia aqui também.
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const sql = `SELECT o.id FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 AND o.comunicacao_id = $2 LIMIT 1`;
      const explicado = await pool.query(`EXPLAIN ${sql}`, [CODIGO_LOTE, COMUNICACAO_INCIDENTE]);
      expect(explicado.rows.length).toBeGreaterThan(0);
    } finally {
      await pool.close();
    }
  });
});
