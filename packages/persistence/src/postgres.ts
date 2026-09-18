import type {
  ConfirmationOwnership,
  ConfirmationRecord,
  ConsumePendingConfirmation,
} from "@integra-correios/pf-workflow";
import type {
  AuditEventInput,
  AcceptOutboxCommand,
  ActivateCommunicationBatchCommand,
  BatchActivationState,
  ClaimedOutboxItem,
  CreateProfessionalCommand,
  EnqueueCommunicationBatchCommand,
  FailOutboxCommand,
  GmailOauthCredentialSource,
  QueryResult,
  SaveOauthConnectionCommand,
  SqlExecutor,
  SqlPool,
  SqlTransaction,
  StoredOauthConnection,
} from "./contracts.js";
import type { EncryptedValue } from "./crypto.js";

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

export class PostgresOperationalRepository implements GmailOauthCredentialSource {
  constructor(private readonly pool: SqlPool) {}

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
          id, origem, codigo, template_versao, status, criado_por, criado_em, ativado_em
        ) VALUES ($1, $2, $3, $4, 'PREPARACAO', $5, $6, NULL)`,
        [
          command.id,
          command.origin,
          command.code,
          command.templateVersion,
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
            destinatario_fingerprint, template_versao, idempotency_key, status, criada_em
          ) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, 'QUEUED', $9)`,
          [
            item.communicationId,
            item.professionalId,
            item.confirmationId,
            command.id,
            command.origin,
            item.recipientFingerprint,
            command.templateVersion,
            item.idempotencyKey,
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
      }>(
        `WITH candidatas AS (
          SELECT outbox.id
          FROM outbox_email outbox
          JOIN comunicacao comunicacao ON comunicacao.id = outbox.comunicacao_id
          JOIN lote_comunicacao lote ON lote.id = comunicacao.lote_comunicacao_id
          WHERE lote.status = 'ATIVO'
            AND (
              (outbox.status IN ('PENDING', 'FAILED') AND outbox.disponivel_em <= $1)
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
          outbox.chave_versao, outbox.tentativas`,
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
