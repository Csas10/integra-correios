import type {
  ConfirmationOwnership,
  ConfirmationRecord,
  ConsumePendingConfirmation,
} from "@integra-correios/pf-workflow";
import { validarCadastroPf } from "@integra-correios/pf-workflow";
import type {
  AuditEventInput,
  AcceptOutboxCommand,
  ActivateCommunicationBatchCommand,
  BatchActivationState,
  BatchCancellationState,
  BatchMode,
  CancelCommunicationBatchCommand,
  ClaimedOutboxItem,
  CommunicationSource,
  ConsumeOauthFlowBindingCommand,
  ConfirmationContext,
  ConfirmationOutcomeResult,
  CreateProfessionalCommand,
  EnqueueCommunicationBatchCommand,
  FailOutboxCommand,
  GmailControlledSendCommand,
  GmailOauthCredentialSource,
  OauthFlowBindingConsumeResult,
  QueryResult,
  RecoverControlledOutboxCommand,
  RefreshedOauthTokenCommand,
  RegisterConfirmationOutcomeCommand,
  RegisterOauthFlowBindingCommand,
  SaveOauthConnectionCommand,
  SqlExecutor,
  SqlPool,
  SqlTransaction,
  StoredOauthConnection,
} from "./contracts.js";
import type { EncryptedValue } from "./crypto.js";
import { createHash, randomUUID } from "node:crypto";

async function inTransaction<T>(pool: SqlPool, operation: (sql: SqlTransaction) => Promise<T>) {
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    const result = await operation(transaction);
    await transaction.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original; a conexão será liberada abaixo.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

function insertAudit(sql: SqlExecutor, event: AuditEventInput): Promise<QueryResult> {
  const forbiddenKey = /(token|secret|senha|cpf|cnpj|documento|email|endereco|telefone|payload|authorization)/i;
  for (const key of Object.keys(event.metadata ?? {})) {
    if (forbiddenKey.test(key)) {
      throw new Error(`Metadado de auditoria proibido: ${key}`);
    }
  }
  return sql.query(
    `INSERT INTO evento_auditoria (
      id, agregado_tipo, agregado_id, tipo, ator_id, ocorreu_em,
      metadados, hash_anterior, hash_evento
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      event.id,
      event.aggregateType,
      event.aggregateId,
      event.type,
      event.actorId ?? null,
      event.occurredAt,
      JSON.stringify(event.metadata ?? {}),
      event.previousHash ?? null,
      event.eventHash,
    ],
  );
}

function encryptedParameters(value: EncryptedValue): readonly unknown[] {
  return [
    Buffer.from(value.ciphertext),
    Buffer.from(value.nonce),
    Buffer.from(value.authTag),
    value.keyVersion,
  ];
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} deve ser SHA-256 hexadecimal`);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} deve ser UUID`);
  }
}

export interface RegistrarImportacaoPfCommand {
  readonly nomeArquivo: string;
  readonly mimeType: string;
  readonly bytesLength: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly folha: string;
  readonly operador: string;
  readonly agora: string;
  readonly linhas: readonly {
    readonly numeroLinha: number;
    /** Valores brutos mapeados — persistidos cifrados, preservados integralmente. */
    readonly dadosBrutos: EncryptedValue;
    readonly documentoFingerprint: string | null;
    readonly statusLinha: "VALIDA" | "PENDENTE" | "INVALIDA";
    readonly inconsistencias: readonly string[];
    /** Profissional a criar quando a linha está elegível (VALIDA/PENDENTE). */
    readonly profissional?: {
      readonly id: string;
      readonly codigoOperacional: string;
      readonly status: string;
      readonly documento: EncryptedValue;
      readonly originalSnapshot: EncryptedValue;
    };
  }[];
}

export interface ResultadoRegistrarImportacao {
  readonly arquivoImportacaoId: string;
  readonly importacaoId: string;
  /** Linhas com núcleo válido (código/nome/CPF/e-mail) — F9. */
  readonly linhasValidas: number;
  readonly linhasPendentes: number;
  readonly linhasInvalidas: number;
  readonly profissionaisCriados: number;
}

export class PostgresOperationalRepository implements GmailOauthCredentialSource {
  /** Acesso de leitura ao pool para casos de consulta do chamador (confirmação). */
  constructor(readonly pool: SqlPool) {}

  async createProfessional(command: CreateProfessionalCommand): Promise<void> {
    assertUuid(command.id, "professional.id");
    assertSha256(command.document.fingerprint, "document.fingerprint");
    if (
      (command.origin === "PF" && command.document.documentType !== "CPF") ||
      (command.origin === "PJ" && command.document.documentType !== "CNPJ")
    ) {
      throw new Error("Tipo de documento incompatível com a origem");
    }

    await inTransaction(this.pool, async (sql) => {
      await sql.query(
        `INSERT INTO profissional (
          id, origem, codigo_operacional, tipo_documento,
          documento_ciphertext, documento_nonce, documento_auth_tag,
          documento_chave_versao, documento_fingerprint, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          command.id,
          command.origin,
          command.operationalCode,
          command.document.documentType,
          ...encryptedParameters(command.document.encrypted),
          command.document.fingerprint,
          command.status,
        ],
      );
      await sql.query(
        `INSERT INTO snapshot_cadastral (
          profissional_id, tipo, conteudo_ciphertext, conteudo_nonce,
          conteudo_auth_tag, chave_versao, fonte
        ) VALUES ($1, 'ORIGINAL', $2, $3, $4, $5, 'IMPORTACAO')`,
        [command.id, ...encryptedParameters(command.originalSnapshot)],
      );
      await insertAudit(sql, command.auditEvent);
    });
  }

  async enqueueCommunicationBatch(command: EnqueueCommunicationBatchCommand): Promise<void> {
    if (command.items.length === 0) throw new Error("Lote de comunicação vazio");
    // F7: modo obrigatório — lote sem modo declarado é erro de contrato
    // (fail-closed), nunca um DEFAULT silencioso.
    if (command.mode !== "DRY_RUN" && command.mode !== "LIVE_PILOT") {
      throw new Error("mode do lote obrigatório (DRY_RUN | LIVE_PILOT)");
    }
    const professionalIds = new Set(command.items.map((item) => item.professionalId));
    if (professionalIds.size !== command.items.length) {
      throw new Error("Profissional duplicado no lote de comunicação");
    }

    await inTransaction(this.pool, async (sql) => {
      // PREPARAÇÃO ≠ LIBERAÇÃO: o lote nasce PREPARACAO — outbox persistida,
      // porém NÃO elegível a claim. Só a ativação explícita e auditável
      // (ativarLoteComunicacao, CAS PREPARACAO → ATIVO) torna os itens
      // elegíveis ao worker.
      await sql.query(
        `INSERT INTO lote_comunicacao (
          id, origem, codigo, template_versao, modo, status, criado_por, criado_em, ativado_em
        ) VALUES ($1, $2, $3, $4, $5, 'PREPARACAO', $6, $7, NULL)`,
        [
          command.id,
          command.origin,
          command.code,
          command.templateVersion,
          // F7: o modo nasce no INSERT — lote DRY_RUN nunca vira LIVE
          // silenciosamente (sem UPDATE de modo em nenhum fluxo).
          command.mode,
          command.createdBy,
          command.createdAt,
        ],
      );

      for (const item of command.items) {
        assertSha256(item.tokenHash, "confirmation.tokenHash");
        assertSha256(item.recipientFingerprint, "communication.recipientFingerprint");
        await sql.query(
          `INSERT INTO confirmacao (
            id, profissional_id, token_hash, template_versao, status,
            emitida_em, expira_em
          ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)`,
          [
            item.confirmationId,
            item.professionalId,
            item.tokenHash,
            command.templateVersion,
            command.createdAt,
            item.expiresAt,
          ],
        );
        await sql.query(
          `INSERT INTO comunicacao (
            id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
            destinatario_fingerprint, template_versao, idempotency_key, status, fonte_registro, criada_em
          ) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, 'QUEUED', $9, $10)`,
          [
            item.communicationId,
            item.professionalId,
            item.confirmationId,
            command.id,
            command.origin,
            item.recipientFingerprint,
            command.templateVersion,
            item.idempotencyKey,
            command.source,
            command.createdAt,
          ],
        );
        await sql.query(
          `INSERT INTO outbox_email (
            id, comunicacao_id, idempotency_key, payload_ciphertext,
            payload_nonce, payload_auth_tag, chave_versao, status, disponivel_em
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)`,
          [
            item.outboxId,
            item.communicationId,
            item.idempotencyKey,
            ...encryptedParameters(item.encryptedPayload),
            command.createdAt,
          ],
        );
        await sql.query(
          `INSERT INTO item_lote_comunicacao (
            lote_comunicacao_id, profissional_id, comunicacao_id, origem, status,
            criado_em, atualizado_em
          ) VALUES ($1, $2, $3, $4, 'ENFILEIRADO', $5, $5)`,
          [command.id, item.professionalId, item.communicationId, command.origin, command.createdAt],
        );
        await insertAudit(sql, item.auditEvent);
      }
      await insertAudit(sql, command.auditEvent);
    });
  }

  /**
   * F8 — Importação confirmada como UMA transação operacional:
   * arquivo_importacao → importacao → linha_importada → profissional
   * → snapshot_cadastral → evento_auditoria, tudo em um único BEGIN/COMMIT.
   * Falha intermediária = ROLLBACK integral (provado por teste de falha no meio).
   *
   * F9 — Contagens semanticamente corretas persistidas em importacao:
   * linhas_validas conta linhas elegíveis (independe de profissionais novos);
   * reimportação do mesmo SHA-256 é idempotente e determinística.
   */
  async registrarImportacaoPf(command: RegistrarImportacaoPfCommand): Promise<ResultadoRegistrarImportacao> {
    assertSha256(command.sha256, "import.sha256");
    if (command.linhas.length === 0) throw new Error("Importação sem linhas");
    return inTransaction(this.pool, async (sql) => {
      // arquivo_importacao — idempotente por SHA-256 (mesma origem).
      const existente = await sql.query<{ id: string }>(
        `SELECT id FROM arquivo_importacao WHERE sha256 = $1 AND origem = 'PF' LIMIT 1`,
        [command.sha256],
      );
      let arquivoId = existente.rows[0]?.id;
      const arquivoJaExistia = Boolean(arquivoId);
      if (!arquivoId) {
        arquivoId = randomUUID();
        await sql.query(
          `INSERT INTO arquivo_importacao (id, origem, nome_original, mime_type, tamanho_bytes, sha256, storage_key)
          VALUES ($1, 'PF', $2, $3, $4, $5, $6)`,
          [arquivoId, command.nomeArquivo, command.mimeType, command.bytesLength, command.sha256, command.storageKey],
        );
      }

      // Um mesmo arquivo reimportado produz nova importação determinística
      // (evidência de execução), com contagens recalculadas.
      const importacaoId = randomUUID();
      await sql.query(
        `INSERT INTO importacao (id, arquivo_importacao_id, origem, status, total_linhas, linhas_validas, linhas_pendentes)
        VALUES ($1, $2, 'PF', 'VALIDADA', $3, 0, 0)`,
        [importacaoId, arquivoId, command.linhas.length],
      );

      let validas = 0;
      let pendentes = 0;
      let invalidas = 0;
      let criados = 0;

      for (const linha of command.linhas) {
        const fingerprint = linha.documentoFingerprint;
        const cifrada = linha.dadosBrutos;
        await sql.query(
          `INSERT INTO linha_importada (importacao_id, folha, numero_linha, dados_brutos_ciphertext, dados_brutos_nonce, dados_brutos_auth_tag, chave_versao, documento_fingerprint, status, inconsistencias)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            importacaoId,
            command.folha,
            linha.numeroLinha,
            Buffer.from(cifrada.ciphertext),
            Buffer.from(cifrada.nonce),
            Buffer.from(cifrada.authTag),
            cifrada.keyVersion,
            fingerprint,
            linha.statusLinha,
            JSON.stringify(linha.inconsistencias),
          ],
        );

        if (linha.statusLinha === "INVALIDA") {
          invalidas += 1;
          continue;
        }
        // F9: válida = linha elegível (VALIDA ou PENDENTE); pendente é subconjunto.
        validas += 1;
        if (linha.statusLinha === "PENDENTE") pendentes += 1;

        const profissional = linha.profissional;
        if (!profissional) continue;

        const jaExiste = await sql.query<{ id: string }>(
          arquivoJaExistia
            ? `SELECT id
              FROM profissional
              WHERE origem = 'PF'
                AND (codigo_operacional = $1 OR documento_fingerprint = $2)
              LIMIT 1`
            : `SELECT id
              FROM profissional
              WHERE origem = 'PF' AND codigo_operacional = $1
              LIMIT 1`,
          arquivoJaExistia
            ? [profissional.codigoOperacional, linha.documentoFingerprint]
            : [profissional.codigoOperacional],
        );
        if (jaExiste.rows[0]) continue;

        await sql.query(
          `INSERT INTO profissional (
            id, origem, codigo_operacional, tipo_documento,
            documento_ciphertext, documento_nonce, documento_auth_tag,
            documento_chave_versao, documento_fingerprint, status
          ) VALUES ($1, 'PF', $2, 'CPF', $3, $4, $5, $6, $7, $8)`,
          [
            profissional.id,
            profissional.codigoOperacional,
            ...encryptedParameters(profissional.documento),
            linha.documentoFingerprint!,
            profissional.status,
          ],
        );
        await sql.query(
          `INSERT INTO snapshot_cadastral (
            profissional_id, tipo, conteudo_ciphertext, conteudo_nonce,
            conteudo_auth_tag, chave_versao, fonte
          ) VALUES ($1, 'ORIGINAL', $2, $3, $4, $5, 'IMPORTACAO')`,
          [profissional.id, ...encryptedParameters(profissional.originalSnapshot)],
        );
        await insertAudit(sql, {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissional.id,
          type: "PF_IMPORTADO",
          actorId: command.operador,
          occurredAt: command.agora,
          metadata: { importacaoId },
          eventHash: createHash("sha256")
            .update(profissional.id)
            .update(command.agora)
            .digest("hex"),
        });
        criados += 1;
      }

      await sql.query(
        `UPDATE importacao
        SET status = 'CONCLUIDA', linhas_validas = $2, linhas_pendentes = $3, concluida_em = now()
        WHERE id = $1`,
        [importacaoId, validas, pendentes],
      );

      return {
        arquivoImportacaoId: arquivoId,
        importacaoId,
        linhasValidas: validas,
        linhasPendentes: pendentes,
        linhasInvalidas: invalidas,
        profissionaisCriados: criados,
      };
    });
  }

  /**
   * Ativação deliberada do lote: CAS PREPARACAO → ATIVO com auditoria.
   * Preparações não elegíveis são rejeitadas deterministicamente:
   *  - inexistente / outra origem → INVALID_STATE;
   *  - vazio → EMPTY;
   *  - alguma comunicação já enviada → ALREADY_SENT;
   *  - CANCELADO/CONCLUIDO → INVALID_STATE;
   *  - ATIVO (segunda ativação) → ALREADY_ACTIVE (idempotente-determinístico).
   */
  async ativarLoteComunicacao(
    command: ActivateCommunicationBatchCommand,
  ): Promise<BatchActivationState> {
    return inTransaction(this.pool, async (sql) => {
      const lote = await sql.query<{
        status: string;
        ativado_em: Date | null;
        criado_em: Date;
        template_versao: string;
        total: string;
      }>(
        `SELECT l.status, l.ativado_em, l.criado_em, l.template_versao,
          (SELECT count(*) FROM item_lote_comunicacao i WHERE i.lote_comunicacao_id = l.id) AS total
        FROM lote_comunicacao l
        WHERE l.id = $1 AND l.origem = $2
        FOR UPDATE`,
        [command.batchId, command.origin],
      );
      const row = lote.rows[0];
      if (!row) {
        throw new Error("INVALID_STATE: lote inexistente ou origem incompatível");
      }
      const totalItems = Number(row.total);
      if (row.status === "ATIVO") {
        return {
          status: "ATIVO",
          totalItems,
          sentItems: 0,
          templateVersion: row.template_versao,
          createdAt: row.criado_em.toISOString(),
          activatedAt: row.ativado_em?.toISOString() ?? null,
          resultCode: "ALREADY_ACTIVE",
        };
      }
      if (totalItems < 1) throw new Error("EMPTY: lote sem itens");
      if (row.status !== "PREPARACAO") {
        throw new Error(`INVALID_STATE: lote em status ${row.status} não pode ser ativado`);
      }
      const enviadas = await sql.query<{ total: string }>(
        `SELECT count(*) AS total
        FROM comunicacao c
        WHERE c.lote_comunicacao_id = $1 AND c.status IN ('ACCEPTED', 'SENT')`,
        [command.batchId],
      );
      if (Number(enviadas.rows[0]?.total ?? 0) > 0) {
        throw new Error("ALREADY_SENT: lote possui comunicação já aceita");
      }
      // CAS: só atualiza se ainda PREPARACAO (protegido pelo FOR UPDATE acima).
      const ativado = await sql.query(
        `UPDATE lote_comunicacao
        SET status = 'ATIVO', ativado_em = $2
        WHERE id = $1 AND origem = $3 AND status = 'PREPARACAO'`,
        [command.batchId, command.activatedAt, command.origin],
      );
      if (ativado.rowCount !== 1) throw new Error("INVALID_STATE: CAS de ativação falhou");
      await insertAudit(sql, command.auditEvent);
      return {
        status: "ATIVO",
        totalItems,
        sentItems: 0,
        templateVersion: row.template_versao,
        createdAt: row.criado_em.toISOString(),
        activatedAt: command.activatedAt,
        resultCode: "ACTIVATED",
      };
    });
  }

  /**
   * Cancelamento auditado de lote DRY_RUN histórico (isolamento operacional):
   * CAS ATIVO → CANCELADO, restrito ao código canônico do lote histórico,
   * somente em modo DRY_RUN, com outbox totalmente resolvida e
   * REAL_SEND_ENABLED=false. Nenhum DELETE e nenhuma alteração em itens,
   * comunicações, outbox, confirmações ou importações — apenas lote.status.
   * Idempotente-determinístico: já CANCELADO → ALREADY_CANCELLED (sem INSERT
   * de novo evento).
   */
  async cancelarLoteComunicacao(
    command: CancelCommunicationBatchCommand,
  ): Promise<BatchCancellationState> {
    if (command.realSendEnabled) {
      throw new Error("REAL_SEND_ARMED: cancelamento exige REAL_SEND_ENABLED=false");
    }
    return inTransaction(this.pool, async (sql) => {
      const lote = await sql.query<{
        codigo: string;
        status: string;
        modo: string;
        criado_em: Date;
        template_versao: string;
        total: string;
      }>(
        `SELECT l.codigo, l.status, l.modo, l.criado_em, l.template_versao,
          (SELECT count(*) FROM item_lote_comunicacao i WHERE i.lote_comunicacao_id = l.id) AS total
        FROM lote_comunicacao l
        WHERE l.id = $1 AND l.origem = $2
        FOR UPDATE`,
        [command.batchId, command.origin],
      );
      const row = lote.rows[0];
      if (!row) {
        throw new Error("NOT_HISTORICAL_BATCH: lote inexistente ou origem incompatível");
      }
      if (row.codigo !== command.expectedCode) {
        throw new Error(`NOT_HISTORICAL_BATCH: código ${row.codigo} não é o lote histórico autorizado`);
      }
      const totalItems = Number(row.total);
      const estado = (): BatchCancellationState => ({
        status: row.status as BatchCancellationState["status"],
        totalItems,
        templateVersion: row.template_versao,
        createdAt: row.criado_em.toISOString(),
        resultCode: "INVALID_STATE",
      });
      if (row.status === "CANCELADO") {
        return { ...estado(), resultCode: "ALREADY_CANCELLED" };
      }
      if (row.status !== "ATIVO") {
        throw new Error(`INVALID_STATE: lote em status ${row.status} não pode ser cancelado`);
      }
      if (row.modo !== "DRY_RUN") {
        throw new Error(`MODE_NOT_DRY_RUN: lote em modo ${row.modo} não é cancelável`);
      }
      const outbox = await sql.query<{ total: string }>(
        `SELECT count(*) AS total
        FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        WHERE c.lote_comunicacao_id = $1 AND o.status IN ('PENDING', 'PROCESSING')`,
        [command.batchId],
      );
      if (Number(outbox.rows[0]?.total ?? 0) > 0) {
        throw new Error("OUTBOX_NOT_SETTLED: outbox pendente ou em processamento");
      }
      // CAS: só atualiza se ainda ATIVO (protegido pelo FOR UPDATE acima).
      const cancelado = await sql.query(
        `UPDATE lote_comunicacao
        SET status = 'CANCELADO'
        WHERE id = $1 AND origem = $2 AND status = 'ATIVO'`,
        [command.batchId, command.origin],
      );
      if (cancelado.rowCount !== 1) throw new Error("INVALID_STATE: CAS de cancelamento falhou");
      await insertAudit(sql, command.auditEvent);
      return {
        status: "CANCELADO",
        totalItems,
        templateVersion: row.template_versao,
        createdAt: row.criado_em.toISOString(),
        resultCode: "CANCELLED",
      };
    });
  }

  /**
   * OUTBOX_GATE_CHAIN_FIX — recuperação auditada EXCLUSIVA da outbox do
   * lote controlado que falhou em CONTROLLED_GATE_OAUTH_NOT_READY
   * (bloqueio de gate PRÉ-messages.send: zero chamada Gmail, OAuth
   * persistido ativo). Transação única: FOR UPDATE no outbox, todas as
   * validações fail-closed, UPDATE para PENDING e evento de auditoria.
   * Nenhuma outra falha (DELIVERY_UNKNOWN, AUTH_REQUIRED, tentativas
   * divergentes, provider ids presentes) é elegível. Idempotente: já
   * recuperado → estado atual sem nova mutação.
   */
  async recuperarOutboxControlada(
    command: RecoverControlledOutboxCommand,
  ): Promise<{ resultCode: "RECOVERED" | "ALREADY_RECOVERED"; outboxId: string; status: string }> {
    if (command.realSendEnabled) {
      throw new Error("REAL_SEND_ARMED: recuperação exige REAL_SEND_ENABLED=false");
    }
    return inTransaction(this.pool, async (sql) => {
      // CORRECTIVE_LEGACY_INCIDENT_BINDING — na classificação LEGADA
      // FAILED_PERMANENT a recuperação fica vinculada à comunicação EXATA do
      // incidente (definida server-side, nunca recebida do navegador) e exige
      // o evento prévio PF_CONTROLLED_RETRY_AUTORIZADO do lote.
      const vinculoLegado = command.expectedCommunicationId !== undefined;
      const parametros: unknown[] = [command.expectedCode];
      let filtroComunicacao = "";
      if (vinculoLegado) {
        parametros.push(command.expectedCommunicationId);
        filtroComunicacao = `AND o.comunicacao_id = $2`;
      }
      const estado = await sql.query<{
        outbox_id: string;
        comunicacao_id: string;
        outbox_status: string;
        tentativas: number;
        erro: string | null;
        lote_status: string;
        lote_modo: string;
        receipts_comunicacao: string;
        provider_ids: string;
        recuperacoes: string;
        retry_autorizado: string;
        pendente_fora: string;
        processamento: string;
        ativos_fora: string;
      }>(
        `SELECT
          o.id AS outbox_id,
          o.comunicacao_id,
          o.status AS outbox_status,
          o.tentativas,
          o.ultimo_erro_codigo AS erro,
          l.status AS lote_status,
          l.modo AS lote_modo,
          (SELECT count(*) FROM comunicacao c2
            WHERE c2.id = o.comunicacao_id AND c2.provider = 'GMAIL') AS receipts_comunicacao,
          (SELECT count(*) FROM comunicacao c3
            WHERE c3.lote_comunicacao_id = l.id
              AND (c3.provider_message_id IS NOT NULL OR c3.provider_thread_id IS NOT NULL)) AS provider_ids,
          (SELECT count(*) FROM evento_auditoria ea
            WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = o.comunicacao_id
              AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO') AS recuperacoes,
          (SELECT count(*) FROM evento_auditoria ea2
            JOIN lote_comunicacao l6 ON l6.id = ea2.agregado_id
            WHERE ea2.agregado_tipo = 'LOTE_COMUNICACAO'
              AND ea2.tipo = 'PF_CONTROLLED_RETRY_AUTORIZADO'
              AND l6.codigo = $1) AS retry_autorizado,
          (SELECT count(*) FROM outbox_email o4
            JOIN comunicacao c4 ON c4.id = o4.comunicacao_id
            JOIN lote_comunicacao l4 ON l4.id = c4.lote_comunicacao_id
            WHERE l4.codigo <> $1 AND o4.status IN ('PENDING', 'FAILED')) AS pendente_fora,
          (SELECT count(*) FROM outbox_email o5 WHERE o5.status = 'PROCESSING') AS processamento,
          (SELECT count(*) FROM lote_comunicacao l5 WHERE l5.status = 'ATIVO' AND l5.codigo <> $1) AS ativos_fora
        FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1${filtroComunicacao}
        ORDER BY o.criada_em DESC
        LIMIT 1
        FOR UPDATE OF o`,
        parametros,
      );
      const linha = estado.rows[0];
      if (!linha) {
        // CORRECTIVE_LEGACY_INCIDENT_BINDING — comunicação divergente ou
        // inexistente: recusa SEM mutação e SEM auditoria.
        throw new Error("COMMUNICATION_MISMATCH: outbox não corresponde à comunicação do incidente legado");
      }
      if (vinculoLegado && linha.comunicacao_id !== command.expectedCommunicationId) {
        throw new Error("COMMUNICATION_MISMATCH: outbox não corresponde à comunicação do incidente legado");
      }
      if (vinculoLegado && Number(linha.retry_autorizado ?? 0) < 1) {
        throw new Error("RETRY_AUTHORIZATION_MISSING: incidente legado exige PF_CONTROLLED_RETRY_AUTORIZADO prévio");
      }
      if (linha.lote_status !== "ATIVO" || linha.lote_modo !== "LIVE_PILOT") {
        throw new Error(`INVALID_STATE: lote em ${linha.lote_status}/${linha.lote_modo} não é recuperável`);
      }
      if (linha.outbox_status === "PENDING") {
        // Idempotência: já recuperado — estado atual, sem nova mutação. O
        // evento de recuperação é procurado pelo comunicacao_id REAL.
        const jaRecuperado = await sql.query<{ total: string }>(
          `SELECT count(*) AS total FROM evento_auditoria ea
          WHERE ea.agregado_tipo = 'COMUNICACAO' AND ea.agregado_id = $2
            AND ea.tipo = 'PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO'`,
          [linha.outbox_id, linha.comunicacao_id],
        );
        if (Number(jaRecuperado.rows[0]?.total ?? 0) > 0) {
          return { resultCode: "ALREADY_RECOVERED", outboxId: linha.outbox_id, status: linha.outbox_status };
        }
        throw new Error("INVALID_STATE: outbox PENDING sem recuperação auditada precedente");
      }
      if (linha.outbox_status !== "FAILED") {
        throw new Error(`INVALID_STATE: outbox em ${linha.outbox_status} não é recuperável`);
      }
      if (linha.erro !== command.expectedErrorCode) {
        throw new Error(`ERROR_CODE_MISMATCH: recuperação exclusiva para ${command.expectedErrorCode} (atual: ${linha.erro ?? "—"})`);
      }
      if (Number(linha.tentativas) !== command.expectedAttempts) {
        throw new Error(`ATTEMPTS_MISMATCH: recuperação exige tentativas=${command.expectedAttempts} (atual: ${linha.tentativas})`);
      }
      // OUTBOX_GATE_CHAIN_FIX — receipts e provider ids contados SOMENTE na
      // comunicação controlada: envios históricos de outros lotes (SENT)
      // jamais bloqueiam a recuperação deste incidente.
      if (Number(linha.receipts_comunicacao) > 0) {
        throw new Error("RECEIPT_ALREADY_EXISTS: existe receipt na comunicação controlada — recuperação proibida");
      }
      if (Number(linha.provider_ids) > 0) {
        throw new Error("PROVIDER_IDS_PRESENT: existe Gmail Message-ID/Thread-ID no lote — recuperação proibida");
      }
      if (Number(linha.recuperacoes) > 0) {
        throw new Error("RECOVERY_ALREADY_AUTHORIZED: recuperação não reexecutável");
      }
      if (Number(linha.pendente_fora) > 0 || Number(linha.processamento) > 0) {
        throw new Error("OUTBOX_NOT_SETTLED: outbox pendente/processing fora do teste");
      }
      if (Number(linha.ativos_fora) > 0) {
        throw new Error("ACTIVE_BATCHES_OUTSIDE_TEST: lotes ATIVOS fora do teste");
      }
      const recuperado = await sql.query(
        `UPDATE outbox_email
        SET status = 'PENDING', disponivel_em = $2, bloqueada_em = NULL, bloqueada_por = NULL
        WHERE id = $1 AND status = 'FAILED'`,
        [linha.outbox_id, command.availableAt],
      );
      if (recuperado.rowCount !== 1) {
        throw new Error("INVALID_STATE: CAS da recuperação falhou");
      }
      // Evento auditado com o comunicacao_id REAL (a idempotência procura
      // por ele) — nunca vazio.
      await insertAudit(sql, {
        ...command.auditEvent,
        aggregateId: linha.comunicacao_id,
      });
      return { resultCode: "RECOVERED", outboxId: linha.outbox_id, status: "PENDING" };
    });
  }

  async claimOutbox(workerId: string, limit: number, now: string): Promise<readonly ClaimedOutboxItem[]> {
    if (!workerId.trim()) throw new Error("workerId obrigatório");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit deve estar entre 1 e 100");
    }
    return inTransaction(this.pool, async (sql) => {
      const result = await sql.query<{
        id: string;
        comunicacao_id: string;
        idempotency_key: string;
        payload_ciphertext: Uint8Array;
        payload_nonce: Uint8Array;
        payload_auth_tag: Uint8Array;
        chave_versao: string;
        tentativas: number;
        fonte: string | null;
      }>(
        `WITH candidatas AS (
          SELECT outbox.id
          FROM outbox_email outbox
          JOIN comunicacao comunicacao ON comunicacao.id = outbox.comunicacao_id
          JOIN lote_comunicacao lote ON lote.id = comunicacao.lote_comunicacao_id
          WHERE lote.status = 'ATIVO'
            AND (
              (outbox.status = 'PENDING' AND outbox.disponivel_em <= $1)
              -- OUTBOX_GATE_CHAIN_FIX: falhas TERMINAIS nunca voltam à fila
              -- pelo agendamento genérico; só a recuperação auditada
              -- (recuperarOutboxControlada) as devolve a PENDING.
              OR (outbox.status = 'FAILED' AND outbox.disponivel_em <= $1
                  AND (outbox.ultimo_erro_codigo IS NULL
                    OR outbox.ultimo_erro_codigo NOT IN
                      ('FAILED_PERMANENT', 'CONTROLLED_GATE_OAUTH_NOT_READY')))
              OR (outbox.status = 'PROCESSING' AND outbox.bloqueada_em <= $1::timestamptz - interval '15 minutes')
            )
          ORDER BY outbox.disponivel_em, outbox.criada_em
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE outbox_email AS outbox
        SET status = 'PROCESSING', bloqueada_em = $1, bloqueada_por = $3,
            tentativas = outbox.tentativas + 1
        FROM candidatas
        WHERE outbox.id = candidatas.id
        RETURNING outbox.id, outbox.comunicacao_id, outbox.idempotency_key,
          outbox.payload_ciphertext, outbox.payload_nonce, outbox.payload_auth_tag,
          outbox.chave_versao, outbox.tentativas,
          (SELECT comunicacao.fonte_registro FROM comunicacao
            WHERE comunicacao.id = outbox.comunicacao_id) AS fonte`,
        [now, limit, workerId],
      );
      if (result.rows.length > 0) {
        await sql.query(
          `UPDATE item_lote_comunicacao
          SET status = 'PROCESSANDO', atualizado_em = $2
          WHERE comunicacao_id = ANY($1::uuid[])`,
          [result.rows.map((row) => row.comunicacao_id), now],
        );
      }
      // F7: modo do lote resolvido por JOIN determinístico (mesma transação,
      // mesmo snapshot do claim) — o worker valida o gate server-side.
      const modos =
        result.rows.length > 0
          ? await sql.query<{ comunicacao_id: string; modo: string }>(
              `SELECT c.id AS comunicacao_id, l.modo
              FROM comunicacao c
              JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
              WHERE c.id = ANY($1::uuid[])`,
              [result.rows.map((row) => row.comunicacao_id)],
            )
          : { rows: [] as { comunicacao_id: string; modo: string }[] };
      const modoPorComunicacao = new Map(modos.rows.map((m) => [m.comunicacao_id, m.modo]));
      return result.rows.map((row) => ({
        id: row.id,
        communicationId: row.comunicacao_id,
        idempotencyKey: row.idempotency_key,
        encryptedPayload: {
          ciphertext: row.payload_ciphertext,
          nonce: row.payload_nonce,
          authTag: row.payload_auth_tag,
          keyVersion: row.chave_versao,
        },
        attempts: row.tentativas,
        modo: (modoPorComunicacao.get(row.comunicacao_id) ?? "DRY_RUN") as BatchMode,
        // FINAL CLOSURE GATE item 2: origem do registro — 0006 backfills
        // 'INSTITUCIONAL_XLSX'; default conservador idêntico.
        fonte: (row.fonte ?? "INSTITUCIONAL_XLSX") as CommunicationSource,
      }));
    });
  }

  async markOutboxAccepted(command: AcceptOutboxCommand): Promise<void> {
    await inTransaction(this.pool, async (sql) => {
      const sent = await sql.query(
        `UPDATE outbox_email
        SET status = 'SENT', enviada_em = $3, bloqueada_em = NULL,
            bloqueada_por = NULL, ultimo_erro_codigo = NULL
        WHERE id = $1 AND comunicacao_id = $2 AND status = 'PROCESSING'`,
        [command.outboxId, command.communicationId, command.acceptedAt],
      );
      if (sent.rowCount !== 1) {
        const current = await sql.query<{
          status: string;
          provider: string;
          provider_message_id: string | null;
          provider_thread_id: string | null;
        }>(
          `SELECT outbox.status, comunicacao.provider, comunicacao.provider_message_id,
            comunicacao.provider_thread_id
          FROM outbox_email AS outbox
          JOIN comunicacao ON comunicacao.id = outbox.comunicacao_id
          WHERE outbox.id = $1 AND outbox.comunicacao_id = $2`,
          [command.outboxId, command.communicationId],
        );
        const previous = current.rows[0];
        if (
          previous?.status === "SENT" &&
          previous.provider === command.provider &&
          previous.provider_message_id === command.providerMessageId &&
          previous.provider_thread_id === (command.providerThreadId ?? null)
        ) return;
        if (previous?.status === "SENT") {
          throw new Error("Conflito de idempotência ao concluir a outbox");
        }
        throw new Error("Outbox não está reservada para conclusão");
      }
      await sql.query(
        `UPDATE comunicacao
        SET provider = $2, provider_message_id = $3, provider_thread_id = $4,
            status = 'ACCEPTED', aceita_em = $5, falhou_em = NULL
        WHERE id = $1`,
        [
          command.communicationId,
          command.provider,
          command.providerMessageId,
          command.providerThreadId ?? null,
          command.acceptedAt,
        ],
      );
      await sql.query(
        `UPDATE item_lote_comunicacao
        SET status = 'ENVIADO', atualizado_em = $2
        WHERE comunicacao_id = $1`,
        [command.communicationId, command.acceptedAt],
      );
      await insertAudit(sql, command.auditEvent);
    });
  }

  async markOutboxFailed(command: FailOutboxCommand): Promise<void> {
    if (!/^[A-Z0-9_.:-]{1,80}$/.test(command.errorCode)) {
      throw new Error("Código de erro deve estar sanitizado");
    }
    await inTransaction(this.pool, async (sql) => {
      const failed = await sql.query(
        `UPDATE outbox_email
        SET status = 'FAILED', disponivel_em = $3, bloqueada_em = NULL,
            bloqueada_por = NULL, ultimo_erro_codigo = $4
        WHERE id = $1 AND comunicacao_id = $2 AND status = 'PROCESSING'`,
        [command.outboxId, command.communicationId, command.retryAt, command.errorCode],
      );
      if (failed.rowCount !== 1) throw new Error("Outbox não está reservada para falha");
      await sql.query(
        `UPDATE comunicacao
        SET status = 'FAILED', falhou_em = $2
        WHERE id = $1`,
        [command.communicationId, command.auditEvent.occurredAt],
      );
      await sql.query(
        `UPDATE item_lote_comunicacao
        SET status = 'FALHOU', atualizado_em = $2
        WHERE comunicacao_id = $1`,
        [command.communicationId, command.auditEvent.occurredAt],
      );
      await insertAudit(sql, command.auditEvent);
    });
  }

  async saveOauthConnection(command: SaveOauthConnectionCommand): Promise<void> {
    const { connection } = command;
    if (connection.provider !== "GMAIL") throw new Error("Provider OAuth não suportado");
    assertSha256(connection.accountFingerprint, "oauth.accountFingerprint");
    const refresh = connection.refreshToken;
    if (refresh && refresh.keyVersion !== connection.accessToken.keyVersion) {
      throw new Error("Tokens OAuth devem usar a mesma versão de chave");
    }
    await inTransaction(this.pool, async (sql) => {
      const saved = await sql.query(
        `INSERT INTO oauth_connection (
          id, provider, conta_fingerprint, scopes,
          access_token_ciphertext, access_token_nonce, access_token_auth_tag,
          refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
          chave_versao, expira_em
        ) VALUES ($1, 'GMAIL', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (provider, conta_fingerprint) DO UPDATE SET
          scopes = EXCLUDED.scopes,
          access_token_ciphertext = EXCLUDED.access_token_ciphertext,
          access_token_nonce = EXCLUDED.access_token_nonce,
          access_token_auth_tag = EXCLUDED.access_token_auth_tag,
          refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
          refresh_token_nonce = EXCLUDED.refresh_token_nonce,
          refresh_token_auth_tag = EXCLUDED.refresh_token_auth_tag,
          chave_versao = EXCLUDED.chave_versao,
          expira_em = EXCLUDED.expira_em,
          revogada_em = NULL,
          atualizada_em = now()
        WHERE oauth_connection.id = EXCLUDED.id
        RETURNING id`,
        [
          connection.id,
          connection.accountFingerprint,
          connection.scopes,
          // Vínculo EXPLÍCITO entre placeholders e colunas — sem spread.
          // encryptedParameters() inclui keyVersion; espalhá-lo aqui deslocava
          // refresh_token_* e chave_versao, quebrando a correspondência
          // 11 placeholders × 11 valores. Ordem exigida pelo INSERT acima:
          //   $4 access_ciphertext, $5 access_nonce, $6 access_auth_tag,
          //   $7 refresh_ciphertext, $8 refresh_nonce, $9 refresh_auth_tag,
          //   $10 chave_versao, $11 expira_em
          Buffer.from(connection.accessToken.ciphertext),
          Buffer.from(connection.accessToken.nonce),
          Buffer.from(connection.accessToken.authTag),
          refresh ? Buffer.from(refresh.ciphertext) : null,
          refresh ? Buffer.from(refresh.nonce) : null,
          refresh ? Buffer.from(refresh.authTag) : null,
          connection.accessToken.keyVersion,
          connection.expiresAt ?? null,
        ],
      );
      // Mesmo id + fingerprint atualiza; novo id + fingerprint existente não
      // satisfaz o WHERE do conflito e retorna zero linhas. A regra usa apenas
      // semântica SQL pública, sem depender de colunas internas MVCC (xmax).
      if (saved.rowCount !== 1 || saved.rows[0]?.id !== connection.id) {
        throw new Error("Conflito entre identidade OAuth e fingerprint da conta");
      }
      await insertAudit(sql, command.auditEvent);
    });
  }

  /**
   * F3 — Atualização segura do access token renovado: persiste o novo envelope
   * cifrado preservando refresh token, scopes e identidade (id + fingerprint).
   * CAS por id: conexão revogada/recriada não recebe token órfão.
   */
  async refreshOauthAccessToken(command: RefreshedOauthTokenCommand): Promise<void> {
    if (command.accountFingerprint !== command.accountFingerprint.trim()) {
      throw new Error("accountFingerprint inválido");
    }
    assertSha256(command.accountFingerprint, "oauth.accountFingerprint");
    await inTransaction(this.pool, async (sql) => {
      const updated = await sql.query(
        `UPDATE oauth_connection
        SET access_token_ciphertext = $3, access_token_nonce = $4, access_token_auth_tag = $5,
          chave_versao = $6, expira_em = $7, revogada_em = NULL, atualizada_em = now()
        WHERE id = $1 AND conta_fingerprint = $2 AND revogada_em IS NULL`,
        [
          command.connectionId,
          command.accountFingerprint,
          Buffer.from(command.accessToken.ciphertext),
          Buffer.from(command.accessToken.nonce),
          Buffer.from(command.accessToken.authTag),
          command.accessToken.keyVersion,
          command.expiresAt,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error("Conexão OAuth não encontrada para renovar token");
      }
    });
  }

  // ==========================================================================
  // F5 — Confirmação do profissional server-side (capability token).
  // Contexto mínimo (sem PII além de nome/endereço apresentado), consumo
  // atômico via compare-and-set e fechamento transacional do workflow PF.
  // ==========================================================================

  /**
   * Contexto mínimo da confirmação para a página pública: decifra o snapshot
   * ORIGINAL e expõe apenas nome, endereço apresentado e telefone mascarado.
   * Falha fechada: token inexistente/expirado/consumido → undefined.
   */
  async obterContextoConfirmacao(
    tokenHash: string,
    caixa: { open(value: EncryptedValue, context: string): Uint8Array },
    agora: string,
  ): Promise<ConfirmationContext | undefined> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return undefined;
    const result = await this.pool.query<{
      conteudo_ciphertext: Uint8Array;
      conteudo_nonce: Uint8Array;
      conteudo_auth_tag: Uint8Array;
      chave_versao: string;
      expira_em: Date;
    }>(
      `SELECT s.conteudo_ciphertext, s.conteudo_nonce, s.conteudo_auth_tag, s.chave_versao,
        c.expira_em
      FROM confirmacao c
      JOIN snapshot_cadastral s ON s.profissional_id = c.profissional_id AND s.tipo = 'ORIGINAL' AND s.vigente
      WHERE c.token_hash = $1 AND c.status = 'PENDING' AND c.expira_em > $2
      LIMIT 1`,
      [tokenHash, agora],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    let snapshot: any = {};
    try {
      snapshot = JSON.parse(
        new TextDecoder().decode(
          caixa.open(
            {
              ciphertext: row.conteudo_ciphertext,
              nonce: row.conteudo_nonce,
              authTag: row.conteudo_auth_tag,
              keyVersion: row.chave_versao,
            },
            "snapshot:original",
          ),
        ),
      );
    } catch {
      return undefined; // fail-closed: snapshot ilegível não é exposto
    }
    const endereco = (snapshot.endereco ?? {}) as Record<string, string | undefined>;
    const telefone = String(snapshot.telefone ?? "");
    const digitos = telefone.replace(/\D/g, "");
    return {
      nome: String(snapshot.nome ?? ""),
      enderecoApresentado: String(snapshot.enderecoOrigem ?? endereco.logradouro ?? ""),
      telefoneMascarado: digitos.length >= 4 ? `***${digitos.slice(-4)}` : "—",
      expiraEm: row.expira_em.toISOString(),
    };
  }

  /** Indica se existe conexão Gmail ativa persistida (readiness F2). */
  async existeConexaoGmailAtiva(): Promise<boolean> {
    const result = await this.pool.query<{ existe: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM oauth_connection WHERE provider = 'GMAIL' AND revogada_em IS NULL
      ) AS existe`,
    );
    return result.rows[0]?.existe === true;
  }

  /**
   * Desconexão auditada da conexão Gmail: revogada_em é marcado em TODAS as
   * conexões ativas do provider (append-only — nenhum registro é apagado) e
   * um evento OAUTH_GMAIL_DISCONNECTED é gravado na mesma transação.
   * Retorna a quantidade de conexões revogadas (0 quando nada estava ativo).
   */
  async revogarConexoesGmail(command: { operador: string; occurredAt: string }): Promise<number> {
    return inTransaction(this.pool, async (sql) => {
      const result = await sql.query(
        `UPDATE oauth_connection
         SET revogada_em = $1, atualizada_em = $1
         WHERE provider = 'GMAIL' AND revogada_em IS NULL`,
        [command.occurredAt],
      );
      const revogadas = result.rowCount ?? 0;
      const eventId = randomUUID();
      await insertAudit(sql, {
        id: eventId,
        aggregateType: "OAUTH_CONNECTION",
        aggregateId: eventId,
        type: "OAUTH_GMAIL_DISCONNECTED",
        occurredAt: command.occurredAt,
        metadata: { revogadas, operador: command.operador },
        eventHash: createHash("sha256").update(eventId).update(command.occurredAt).digest("hex"),
      });
      return revogadas;
    });
  }

  /**
   * Fechamento transacional da confirmação: snapshot ORIGINAL preservado,
   * snapshot decidido criado (CONFIRMADO), workflow avançado e auditoria —
   * tudo em uma única transação. Falha = ROLLBACK integral.
   */
  async registrarResultadoConfirmacao(command: RegisterConfirmationOutcomeCommand): Promise<ConfirmationOutcomeResult> {
    const agora = command.occurredAt;
    return inTransaction(this.pool, async (sql) => {
      // 1) Snapshot decidido (proposto em ATUALIZAR, confirmado em CONFIRMAR).
      const snapshotId = randomUUID();
      const snapshotCifrado = command.snapshotCifrado;
      await sql.query(
        `INSERT INTO snapshot_cadastral (
          id, profissional_id, tipo, conteudo_ciphertext, conteudo_nonce,
          conteudo_auth_tag, chave_versao, fonte
        ) VALUES ($1, $2, 'CONFIRMADO', $3, $4, $5, $6, $7)`,
        [
          snapshotId,
          command.professionalId,
          ...encryptedParameters(snapshotCifrado),
          command.fonte,
        ],
      );
      // 2) Confirmação aponta para o snapshot decidido.
      await sql.query(
        `UPDATE confirmacao SET snapshot_confirmado_id = $2 WHERE id = $1`,
        [command.confirmationId, snapshotId],
      );
      // 3) Workflow: estado final server-side — regras do pf-workflow decidem
      // APTO_PREPOSTAGEM vs PENDENCIA_CADASTRAL conforme os dados decididos.
      const cadastro = command.snapshotDecidido as {
        documento?: string;
        nome?: string;
        email?: string;
        telefone?: string;
        endereco?: Record<string, string>;
      };
      const validacao = validarCadastroPf({
        documento: String(cadastro.documento ?? ""),
        nome: String(cadastro.nome ?? ""),
        email: String(cadastro.email ?? ""),
        telefone: String(cadastro.telefone ?? ""),
        endereco: {
          logradouro: String(cadastro.endereco?.logradouro ?? ""),
          numero: String(cadastro.endereco?.numero ?? ""),
          bairro: String(cadastro.endereco?.bairro ?? ""),
          cidade: String(cadastro.endereco?.cidade ?? ""),
          uf: String(cadastro.endereco?.uf ?? ""),
          cep: String(cadastro.endereco?.cep ?? ""),
        },
      });
      const novoStatus: ConfirmationOutcomeResult["status"] = validacao.valid
        ? "APTO_PREPOSTAGEM"
        : "PENDENCIA_CADASTRAL";
      await sql.query(
        `UPDATE profissional SET status = $2, atualizado_em = $3
        WHERE id = $1 AND origem = 'PF'`,
        [command.professionalId, novoStatus, agora],
      );
      // 4) Auditoria — sem PII nos metadados.
      await insertAudit(sql, {
        id: randomUUID(),
        aggregateType: "PROFISSIONAL",
        aggregateId: command.professionalId,
        type: "PF_CONFIRMACAO_SUBMETIDA",
        occurredAt: agora,
        metadata: { confirmationId: command.confirmationId, decisao: command.decisao, statusFinal: novoStatus },
        eventHash: createHash("sha256").update(command.confirmationId).update(agora).digest("hex"),
      });

      // A confirmação encerra o item somente depois de uma comunicação aceita.
      // Assim, um token consumido fora de ordem nunca libera uma reserva que
      // ainda não passou pelo worker.
      const comunicacao = await sql.query<{
        id: string;
        lote_comunicacao_id: string;
        status: string;
      }>(
        `SELECT c.id, c.lote_comunicacao_id, c.status
        FROM comunicacao c
        WHERE c.confirmacao_id = $1 AND c.profissional_id = $2
        FOR UPDATE`,
        [command.confirmationId, command.professionalId],
      );
      const vinculada = comunicacao.rows[0];
      if (vinculada && (vinculada.status === "ACCEPTED" || vinculada.status === "DELIVERED")) {
        await sql.query(
          `UPDATE item_lote_comunicacao
          SET status = 'CONCLUIDO', atualizado_em = $2
          WHERE comunicacao_id = $1 AND status = 'ENVIADO'`,
          [vinculada.id, agora],
        );

        const lote = await sql.query<{ status: string }>(
          `SELECT status
          FROM lote_comunicacao
          WHERE id = $1
          FOR UPDATE`,
          [vinculada.lote_comunicacao_id],
        );
        const statusLote = lote.rows[0]?.status;
        if (statusLote === "ATIVO") {
          const pendencias = await sql.query<{ total: string; pendentes: string }>(
            `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status NOT IN ('CONCLUIDO', 'CANCELADO'))::text AS pendentes
            FROM item_lote_comunicacao
            WHERE lote_comunicacao_id = $1`,
            [vinculada.lote_comunicacao_id],
          );
          const resumo = pendencias.rows[0];
          if (resumo && Number(resumo.total) > 0 && Number(resumo.pendentes) === 0) {
            await sql.query(
              `UPDATE lote_comunicacao
              SET status = 'CONCLUIDO', concluido_em = $2
              WHERE id = $1 AND status = 'ATIVO'`,
              [vinculada.lote_comunicacao_id, agora],
            );
            await insertAudit(sql, {
              id: randomUUID(),
              aggregateType: "LOTE_COMUNICACAO",
              aggregateId: vinculada.lote_comunicacao_id,
              type: "PF_LOTE_COMUNICACAO_CONCLUIDO",
              actorId: command.fonte,
              occurredAt: agora,
              metadata: { totalItens: Number(resumo.total), motivo: "TODAS_CONFIRMADAS" },
              eventHash: createHash("sha256")
                .update(vinculada.lote_comunicacao_id)
                .update("CONCLUIDO")
                .update(agora)
                .digest("hex"),
            });
          }
        }
      }
      return {
        confirmationId: command.confirmationId,
        professionalId: command.professionalId,
        status: novoStatus,
        snapshotId,
      };
    });
  }

  async loadGmailConnection(accountFingerprint: string): Promise<StoredOauthConnection | undefined> {
    assertSha256(accountFingerprint, "oauth.accountFingerprint");
    const result = await this.pool.query<{
      id: string;
      conta_fingerprint: string;
      scopes: string[];
      access_token_ciphertext: Uint8Array;
      access_token_nonce: Uint8Array;
      access_token_auth_tag: Uint8Array;
      refresh_token_ciphertext: Uint8Array | null;
      refresh_token_nonce: Uint8Array | null;
      refresh_token_auth_tag: Uint8Array | null;
      chave_versao: string;
      expira_em: Date | null;
    }>(
      `SELECT id, conta_fingerprint, scopes,
        access_token_ciphertext, access_token_nonce, access_token_auth_tag,
        refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
        chave_versao, expira_em
      FROM oauth_connection
      WHERE provider = 'GMAIL' AND conta_fingerprint = $1 AND revogada_em IS NULL`,
      [accountFingerprint],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const accessToken: EncryptedValue = {
      ciphertext: row.access_token_ciphertext,
      nonce: row.access_token_nonce,
      authTag: row.access_token_auth_tag,
      keyVersion: row.chave_versao,
    };
    const base = {
      id: row.id,
      provider: "GMAIL" as const,
      accountFingerprint: row.conta_fingerprint,
      scopes: row.scopes,
      accessToken,
    };
    const withRefresh = row.refresh_token_ciphertext && row.refresh_token_nonce && row.refresh_token_auth_tag
      ? {
          ...base,
          refreshToken: {
            ciphertext: row.refresh_token_ciphertext,
            nonce: row.refresh_token_nonce,
            authTag: row.refresh_token_auth_tag,
            keyVersion: row.chave_versao,
          },
        }
      : base;
    return row.expira_em
      ? { ...withRefresh, expiresAt: row.expira_em.toISOString() }
      : withRefresh;
  }

  // -------------------------------------------------------------------------
  // F18 — Binding one-time do fluxo OAuth em PostgreSQL. START (instância A)
  // registra o hash do nonce; CALLBACK (qualquer instância) consome
  // atomicamente. O nonce em claro NUNCA é persistido.
  // -------------------------------------------------------------------------

  async verificarEnvioControlado(
    command: GmailControlledSendCommand,
  ): Promise<{ ok: true } | { ok: false; motivo: string }> {
    // FINAL CLOSURE GATE item 2 — GATE 2 REAL (não apenas readiness):
    // verificação server-side imediatamente antes de users.messages.send.
    // Falha fechada: qualquer divergência → zero chamadas ao Gmail.
    if (command.fonte !== "CONTROLADO_SINTETICO") {
      return { ok: false, motivo: "SOURCE_NOT_SYNTHETIC" };
    }
    const controlado = (process.env.GMAIL_CONTROLLED_RECIPIENT ?? "").trim().toLowerCase();
    if (!controlado) {
      return { ok: false, motivo: "CONTROLLED_RECIPIENT_MISSING" };
    }
    // Normalização RFC 5322 mínima: extrai endereço de "Nome <a@b>".
    const endereco = /<([^>]+)>/.exec(command.destinatario)?.[1] ?? command.destinatario;
    if (endereco.trim().toLowerCase() !== controlado) {
      return { ok: false, motivo: "RECIPIENT_MISMATCH" };
    }
    if (!command.oauthPronto) {
      return { ok: false, motivo: "OAUTH_NOT_READY" };
    }
    // Lote ATIVO, exatamente 1 item, liberação humana auditada
    // (PF_LOTE_COMUNICACAO_ATIVADO) e ausência de receipt Gmail anterior —
    // tudo derivado do banco, na mesma consulta.
    const estado = await this.pool.query<{
      lote_status: string;
      total_itens: string;
      ativacoes: string;
      receipts: string;
    }>(
      `SELECT
        l.status AS lote_status,
        (SELECT count(*) FROM item_lote_comunicacao i WHERE i.lote_comunicacao_id = l.id) AS total_itens,
        (SELECT count(*) FROM evento_auditoria ea
          WHERE ea.agregado_tipo = 'LOTE_COMUNICACAO' AND ea.agregado_id = l.id
            AND ea.tipo = 'PF_LOTE_COMUNICACAO_ATIVADO') AS ativacoes,
        (SELECT count(*) FROM comunicacao c2
          WHERE c2.lote_comunicacao_id = l.id AND c2.provider = 'GMAIL') AS receipts
      FROM comunicacao c
      JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
      WHERE c.id = $1`,
      [command.communicationId],
    );
    const linha = estado.rows[0];
    if (!linha) return { ok: false, motivo: "COMMUNICATION_NOT_FOUND" };
    if (linha.lote_status !== "ATIVO") return { ok: false, motivo: "BATCH_NOT_ACTIVE" };
    if (Number(linha.total_itens) !== 1) return { ok: false, motivo: "CONTROLLED_BATCH_SIZE" };
    if (Number(linha.ativacoes) < 1) return { ok: false, motivo: "HUMAN_RELEASE_NOT_AUDITED" };
    if (Number(linha.receipts) > 0) return { ok: false, motivo: "PREVIOUS_RECEIPT" };
    return { ok: true };
  }

  async registrarBindingOauthFlow(command: RegisterOauthFlowBindingCommand): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(command.nonceHash)) {
      throw new Error("nonceHash deve ser SHA-256 hex (64 caracteres)");
    }
    if (!/^[0-9a-f]{64}$/.test(command.operadorHash)) {
      throw new Error("operadorHash deve ser SHA-256 hex (64 caracteres)");
    }
    // FINAL CLOSURE GATE item 1: o code_verifier PKCE fica NO BANCO (cifrado,
    // AES-256-GCM) — nunca no state/browser. O hash do operador ancora a
    // sessão do START; callback divergente é rejeitado (SESSION_MISMATCH).
    await this.pool.query(
      `INSERT INTO oauth_flow (
        nonce_hash, code_verifier_ciphertext, code_verifier_nonce,
        code_verifier_auth_tag, code_verifier_chave_versao, operador_hash, expira_em
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        command.nonceHash,
        ...encryptedParameters(command.codeVerifier),
        command.operadorHash,
        command.expiresAt,
      ],
    );
  }

  async consumirBindingOauthFlow(
    command: ConsumeOauthFlowBindingCommand,
  ): Promise<OauthFlowBindingConsumeResult> {
    if (!/^[0-9a-f]{64}$/.test(command.nonceHash)) {
      throw new Error("nonceHash deve ser SHA-256 hex (64 caracteres)");
    }
    if (!/^[0-9a-f]{64}$/.test(command.operadorHash)) {
      throw new Error("operadorHash deve ser SHA-256 hex (64 caracteres)");
    }
    // Consumo one-time ATÔMICO: o UPDATE com RETURNING vence exatamente uma
    // vez mesmo com callbacks concorrentes (row lock do UPDATE) e EXIGE o
    // MESMO operador do START. Replay, expiração, nonce desconhecido e
    // sessão divergente falham fechados.
    const result = await this.pool.query<{
      id: string;
      code_verifier_ciphertext: Uint8Array;
      code_verifier_nonce: Uint8Array;
      code_verifier_auth_tag: Uint8Array;
      code_verifier_chave_versao: string;
    }>(
      `UPDATE oauth_flow
      SET consumida_em = $3
      WHERE nonce_hash = $1
        AND operador_hash = $2
        AND consumida_em IS NULL
        AND expira_em > $3
      RETURNING id, code_verifier_ciphertext, code_verifier_nonce,
        code_verifier_auth_tag, code_verifier_chave_versao`,
      [command.nonceHash, command.operadorHash, command.now],
    );
    const row = result.rows[0];
    if (row) {
      if (
        !row.code_verifier_ciphertext ||
        !row.code_verifier_nonce ||
        !row.code_verifier_auth_tag
      ) {
        // Binding pré-PKCE (sem verifier): fail-closed, nunca consumido.
        return { status: "SESSION_MISMATCH" };
      }
      return {
        status: "CONSUMED",
        codeVerifierSealed: {
          ciphertext: row.code_verifier_ciphertext,
          nonce: row.code_verifier_nonce,
          authTag: row.code_verifier_auth_tag,
          keyVersion: row.code_verifier_chave_versao,
        },
      };
    }
    // Não consumiu: distinguir MISSING/EXPIRED/REPLAY/SESSION_MISMATCH.
    const estado = await this.pool.query<{
      consumida_em: Date | null;
      expira_em: Date;
      operador_hash: string | null;
    }>(`SELECT consumida_em, expira_em, operador_hash FROM oauth_flow WHERE nonce_hash = $1`, [
      command.nonceHash,
    ]);
    const registro = estado.rows[0];
    if (!registro) return { status: "MISSING" };
    if (registro.consumida_em !== null) return { status: "REPLAY" };
    if (registro.expira_em.getTime() <= new Date(command.now).getTime()) {
      return { status: "EXPIRED" };
    }
    if (registro.operador_hash !== command.operadorHash) return { status: "SESSION_MISMATCH" };
    return { status: "MISSING" };
  }
}

export class PostgresConfirmationOwnership implements ConfirmationOwnership {
  constructor(private readonly pool: SqlPool) {}

  async registerPending(confirmation: ConfirmationRecord): Promise<void> {
    const separator = confirmation.professionalId.indexOf("|");
    const origin = confirmation.professionalId.slice(0, separator);
    const code = confirmation.professionalId.slice(separator + 1);
    if (!(["PF", "PJ"] as const).includes(origin as "PF" | "PJ") || !code) {
      throw new Error("Identidade operacional inválida");
    }
    const result = await this.pool.query(
      `INSERT INTO confirmacao (
        id, profissional_id, token_hash, template_versao, status, emitida_em, expira_em
      )
      SELECT $1, id, $2, $3, 'PENDING', $4, $5
      FROM profissional
      WHERE origem = $6 AND codigo_operacional = $7`,
      [
        confirmation.id,
        confirmation.tokenHash,
        confirmation.templateVersion,
        confirmation.issuedAt,
        confirmation.expiresAt,
        origin,
        code,
      ],
    );
    if (result.rowCount !== 1) throw new Error("Profissional não encontrado para confirmação");
  }

  async consumePending(command: ConsumePendingConfirmation): Promise<ConfirmationRecord | undefined> {
    const result = await this.pool.query<{
      id: string;
      professional_id: string;
      token_hash: string;
      emitida_em: Date;
      expira_em: Date;
      consumida_em: Date;
      template_versao: string;
      decisao: "CONFIRMAR" | "ATUALIZAR";
    }>(
      `WITH consumida AS (
        UPDATE confirmacao
        SET status = 'SUBMITTED', consumida_em = $3, decisao = $4
        WHERE id = $1 AND token_hash = $2 AND status = 'PENDING' AND expira_em > $3
        RETURNING *
      )
      SELECT consumida.id,
        profissional.origem || '|' || profissional.codigo_operacional AS professional_id,
        consumida.token_hash, consumida.emitida_em, consumida.expira_em,
        consumida.consumida_em, consumida.template_versao, consumida.decisao
      FROM consumida
      JOIN profissional ON profissional.id = consumida.profissional_id`,
      [command.confirmationId, command.tokenHash, command.usedAt, command.decision],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      professionalId: row.professional_id as ConfirmationRecord["professionalId"],
      tokenHash: row.token_hash,
      issuedAt: row.emitida_em.toISOString(),
      expiresAt: row.expira_em.toISOString(),
      usedAt: row.consumida_em.toISOString(),
      status: "SUBMITTED",
      decision: row.decisao,
      templateVersion: row.template_versao,
    };
  }
}
