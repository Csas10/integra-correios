import { createHash, randomUUID } from "node:crypto";
import type { QueryResult, SqlExecutor, SqlPool, SqlTransaction } from "./contracts.js";

export const OPERATOR_ROLES = [
  "PREPARADOR",
  "REVISOR",
  "APROVADOR",
  "EXECUTOR",
  "SUPERVISOR",
  "ADMIN_TECNICO",
] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];
export type OperatorStatus = "ATIVO" | "SUSPENSO";

export interface OperatorIdentity {
  readonly operatorId: string;
  readonly code: string;
  readonly displayName: string;
  readonly status: OperatorStatus;
  readonly roles: readonly OperatorRole[];
  readonly sessionExpiresAt: string;
}

export class OperatorAdminAuthorizationError extends Error {
  readonly code = "OPERATOR_ADMIN_AUTH_REQUIRED";

  constructor() {
    super("Administrador técnico individual ativo é obrigatório");
    this.name = "OperatorAdminAuthorizationError";
  }
}

export class InitialAdminBootstrapError extends Error {
  readonly code = "INITIAL_ADMIN_BOOTSTRAP_FORBIDDEN";

  constructor() {
    super("Bootstrap inicial permitido somente quando não existe operador");
    this.name = "InitialAdminBootstrapError";
  }
}

export interface BootstrapInitialAdminCommand {
  readonly operatorId: string;
  readonly code: string;
  readonly displayName: string;
  readonly tokenHash: string;
  readonly now: string;
  readonly tokenExpiresAt?: string;
}

export interface ProvisionOperatorCommand {
  readonly actorOperatorId: string;
  readonly operatorId: string;
  readonly code: string;
  readonly displayName: string;
  readonly roles: readonly OperatorRole[];
  readonly tokenHash: string;
  readonly now: string;
  readonly tokenExpiresAt?: string;
}

export interface ReplaceOperatorCredentialCommand {
  readonly actorOperatorId: string;
  readonly operatorId: string;
  readonly tokenHash: string;
  readonly reason: "ROTACAO" | "RECUPERACAO";
  readonly now: string;
  readonly tokenExpiresAt?: string;
}

export interface CreateOperatorSessionCommand {
  readonly tokenHash: string;
  readonly sessionHash: string;
  readonly now: string;
  readonly sessionExpiresAt: string;
}

async function inTransaction<T>(
  pool: SqlPool,
  operation: (sql: SqlTransaction) => Promise<T>,
): Promise<T> {
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    const result = await operation(transaction);
    await transaction.query("COMMIT");
    return result;
  } catch (error) {
    try { await transaction.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    transaction.release();
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} deve ser SHA-256 hexadecimal`);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} deve ser UUID`);
  }
}

function normalizeRoles(roles: readonly OperatorRole[]): OperatorRole[] {
  const unique = [...new Set(roles)];
  if (unique.length === 0) throw new Error("Operador deve possuir ao menos um papel");
  for (const role of unique) {
    if (!OPERATOR_ROLES.includes(role)) throw new Error("Papel operacional inválido");
  }
  return unique.sort();
}

function eventHash(eventId: string, operatorId: string, type: string, occurredAt: string): string {
  return createHash("sha256")
    .update(eventId).update("|").update(operatorId).update("|")
    .update(type).update("|").update(occurredAt).digest("hex");
}

async function insertOperatorAudit(
  sql: SqlExecutor,
  operatorId: string,
  actorId: string,
  type: string,
  occurredAt: string,
  metadata: Readonly<Record<string, string | number | boolean | null>> = {},
): Promise<QueryResult> {
  const eventId = randomUUID();
  return sql.query(
    `INSERT INTO evento_auditoria (
      id, agregado_tipo, agregado_id, tipo, ator_id, operator_id, ator_operator_id,
      ocorreu_em, metadados, hash_evento
    ) VALUES ($1, 'OPERADOR', $2, $3, $4, $2, $5, $6, $7::jsonb, $8)`,
    [
      eventId,
      operatorId,
      type,
      actorId,
      actorId,
      occurredAt,
      JSON.stringify(metadata),
      eventHash(eventId, operatorId, type, occurredAt),
    ],
  );
}

async function loadRoles(sql: SqlExecutor, operatorId: string): Promise<OperatorRole[]> {
  const result = await sql.query<{ papel: OperatorRole }>(
    `SELECT papel FROM operador_papel
      WHERE operator_id = $1 AND ativo = true ORDER BY papel`,
    [operatorId],
  );
  return result.rows.map((row) => row.papel);
}

async function assertActiveTechnicalAdmin(
  sql: SqlExecutor,
  actorOperatorId: string,
): Promise<void> {
  const authorized = await sql.query<{ id: string }>(
    `SELECT o.id
       FROM operador o
       JOIN operador_papel p
         ON p.operator_id = o.id
        AND p.papel = 'ADMIN_TECNICO'
        AND p.ativo = true
      WHERE o.id = $1
        AND o.status = 'ATIVO'
      FOR UPDATE OF o, p`,
    [actorOperatorId],
  );
  if (!authorized.rows[0]) {
    throw new OperatorAdminAuthorizationError();
  }
}

export class PostgresOperatorIdentityRepository {
  constructor(readonly pool: SqlPool) {}

  async bootstrapInitialAdmin(command: BootstrapInitialAdminCommand): Promise<void> {
    assertUuid(command.operatorId, "operatorId");
    assertSha256(command.tokenHash, "tokenHash");
    const code = command.code.trim();
    const displayName = command.displayName.trim();
    if (!code || code.length > 80) throw new Error("Código do operador inválido");
    if (!displayName || displayName.length > 160) throw new Error("Nome do operador inválido");

    await inTransaction(this.pool, async (sql) => {
      await sql.query("LOCK TABLE operador IN SHARE ROW EXCLUSIVE MODE");
      const existing = await sql.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM operador",
      );
      if (Number(existing.rows[0]?.total ?? "0") !== 0) {
        throw new InitialAdminBootstrapError();
      }

      await sql.query(
        `INSERT INTO operador (
          id, codigo, nome_exibicao, status, criado_em, atualizado_em
        ) VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [command.operatorId, code, displayName, command.now],
      );
      await sql.query(
        `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
         VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
        [command.operatorId, command.now],
      );
      await sql.query(
        `INSERT INTO operador_token (
          id, operator_id, token_hash, emitido_por_operator_id, status, criado_em, expira_em
        ) VALUES ($1, $2, $3, $2, 'ATIVO', $4, $5)`,
        [
          randomUUID(),
          command.operatorId,
          command.tokenHash,
          command.now,
          command.tokenExpiresAt ?? null,
        ],
      );
      await insertOperatorAudit(
        sql,
        command.operatorId,
        command.operatorId,
        "ADMIN_BOOTSTRAP_INICIAL",
        command.now,
      );
    });
  }

  async provisionOperator(command: ProvisionOperatorCommand): Promise<void> {
    assertUuid(command.actorOperatorId, "actorOperatorId");
    assertUuid(command.operatorId, "operatorId");
    assertSha256(command.tokenHash, "tokenHash");
    const roles = normalizeRoles(command.roles);
    const code = command.code.trim();
    const displayName = command.displayName.trim();
    if (!code || code.length > 80) throw new Error("Código do operador inválido");
    if (!displayName || displayName.length > 160) throw new Error("Nome do operador inválido");

    await inTransaction(this.pool, async (sql) => {
      await assertActiveTechnicalAdmin(sql, command.actorOperatorId);
      await sql.query(
        `INSERT INTO operador (
          id, codigo, nome_exibicao, status, criado_em, atualizado_em
        ) VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [command.operatorId, code, displayName, command.now],
      );
      for (const role of roles) {
        await sql.query(
          `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
           VALUES ($1, $2, true, $3)`,
          [command.operatorId, role, command.now],
        );
      }
      await sql.query(
        `INSERT INTO operador_token (
          id, operator_id, token_hash, emitido_por_operator_id, status, criado_em, expira_em
        ) VALUES ($1, $2, $3, $4, 'ATIVO', $5, $6)`,
        [
          randomUUID(),
          command.operatorId,
          command.tokenHash,
          command.actorOperatorId,
          command.now,
          command.tokenExpiresAt ?? null,
        ],
      );
      await insertOperatorAudit(
        sql, command.operatorId, command.actorOperatorId,
        "OPERADOR_PROVISIONADO", command.now, { role_count: roles.length },
      );
    });
  }

  async createSessionFromToken(
    command: CreateOperatorSessionCommand,
  ): Promise<OperatorIdentity | undefined> {
    assertSha256(command.tokenHash, "tokenHash");
    assertSha256(command.sessionHash, "sessionHash");
    return inTransaction(this.pool, async (sql) => {
      const token = await sql.query<{
        token_id: string; operator_id: string; codigo: string;
        nome_exibicao: string; status: OperatorStatus;
      }>(
        `SELECT t.id AS token_id, o.id AS operator_id, o.codigo, o.nome_exibicao, o.status
           FROM operador_token t
           JOIN operador o ON o.id = t.operator_id
          WHERE t.token_hash = $1
            AND t.status = 'ATIVO'
            AND (t.expira_em IS NULL OR t.expira_em > $2::timestamptz)
            AND o.status = 'ATIVO'
          FOR UPDATE OF t, o`,
        [command.tokenHash, command.now],
      );
      const row = token.rows[0];
      if (!row) return undefined;
      const roles = await loadRoles(sql, row.operator_id);
      if (roles.length === 0) return undefined;
      await sql.query(
        `INSERT INTO operador_sessao (
          id, operator_id, token_id, session_hash, status, criada_em, expira_em
        ) VALUES ($1, $2, $3, $4, 'ATIVA', $5, $6)`,
        [randomUUID(), row.operator_id, row.token_id, command.sessionHash, command.now, command.sessionExpiresAt],
      );
      await insertOperatorAudit(sql, row.operator_id, row.operator_id, "OPERADOR_SESSAO_CRIADA", command.now);
      return {
        operatorId: row.operator_id,
        code: row.codigo,
        displayName: row.nome_exibicao,
        status: row.status,
        roles,
        sessionExpiresAt: command.sessionExpiresAt,
      };
    });
  }

  async resolveSession(sessionHash: string, now: string): Promise<OperatorIdentity | undefined> {
    assertSha256(sessionHash, "sessionHash");
    const session = await this.pool.query<{
      operator_id: string; codigo: string; nome_exibicao: string;
      status: OperatorStatus; expira_em: string | Date;
    }>(
      `SELECT o.id AS operator_id, o.codigo, o.nome_exibicao, o.status, s.expira_em
         FROM operador_sessao s
         JOIN operador o ON o.id = s.operator_id
         JOIN operador_token t ON t.id = s.token_id
                              AND t.operator_id = s.operator_id
        WHERE s.session_hash = $1
          AND s.status = 'ATIVA'
          AND s.expira_em > $2::timestamptz
          AND o.status = 'ATIVO'
          AND t.status = 'ATIVO'
          AND (t.expira_em IS NULL OR t.expira_em > $2::timestamptz)
        LIMIT 1`,
      [sessionHash, now],
    );
    const row = session.rows[0];
    if (!row) return undefined;
    const roles = await loadRoles(this.pool, row.operator_id);
    if (roles.length === 0) return undefined;
    return {
      operatorId: row.operator_id,
      code: row.codigo,
      displayName: row.nome_exibicao,
      status: row.status,
      roles,
      sessionExpiresAt: row.expira_em instanceof Date ? row.expira_em.toISOString() : String(row.expira_em),
    };
  }

  async revokeSession(sessionHash: string, now: string): Promise<boolean> {
    assertSha256(sessionHash, "sessionHash");
    return inTransaction(this.pool, async (sql) => {
      const updated = await sql.query<{ operator_id: string }>(
        `UPDATE operador_sessao
            SET status = 'REVOGADA', revogada_em = $2
          WHERE session_hash = $1 AND status = 'ATIVA'
        RETURNING operator_id`,
        [sessionHash, now],
      );
      const operatorId = updated.rows[0]?.operator_id;
      if (!operatorId) return false;
      await insertOperatorAudit(sql, operatorId, operatorId, "OPERADOR_SESSAO_REVOGADA", now);
      return true;
    });
  }

  async replaceCredential(command: ReplaceOperatorCredentialCommand): Promise<boolean> {
    assertUuid(command.actorOperatorId, "actorOperatorId");
    assertUuid(command.operatorId, "operatorId");
    assertSha256(command.tokenHash, "tokenHash");
    return inTransaction(this.pool, async (sql) => {
      await assertActiveTechnicalAdmin(sql, command.actorOperatorId);
      const active = await sql.query<{ id: string }>(
        `SELECT id FROM operador
          WHERE id = $1 AND status = 'ATIVO'
          FOR UPDATE`,
        [command.operatorId],
      );
      if (!active.rows[0]) return false;

      await sql.query(
        `UPDATE operador_token
            SET status = 'REVOGADO', revogado_em = $2
          WHERE operator_id = $1 AND status = 'ATIVO'`,
        [command.operatorId, command.now],
      );
      await sql.query(
        `UPDATE operador_sessao
            SET status = 'REVOGADA', revogada_em = $2
          WHERE operator_id = $1 AND status = 'ATIVA'`,
        [command.operatorId, command.now],
      );
      await sql.query(
        `INSERT INTO operador_token (
          id, operator_id, token_hash, emitido_por_operator_id, status, criado_em, expira_em
        ) VALUES ($1, $2, $3, $4, 'ATIVO', $5, $6)`,
        [
          randomUUID(),
          command.operatorId,
          command.tokenHash,
          command.actorOperatorId,
          command.now,
          command.tokenExpiresAt ?? null,
        ],
      );
      await insertOperatorAudit(
        sql,
        command.operatorId,
        command.actorOperatorId,
        command.reason === "ROTACAO"
          ? "OPERADOR_CREDENCIAL_ROTACIONADA"
          : "OPERADOR_CREDENCIAL_RECUPERADA",
        command.now,
      );
      return true;
    });
  }

  async suspendOperator(
    operatorId: string,
    actorOperatorId: string,
    now: string,
  ): Promise<boolean> {
    assertUuid(operatorId, "operatorId");
    assertUuid(actorOperatorId, "actorOperatorId");
    return inTransaction(this.pool, async (sql) => {
      await assertActiveTechnicalAdmin(sql, actorOperatorId);
      const updated = await sql.query<{ id: string }>(
        `UPDATE operador
            SET status = 'SUSPENSO', atualizado_em = $2, suspenso_em = $2
          WHERE id = $1 AND status = 'ATIVO'
        RETURNING id`,
        [operatorId, now],
      );
      if (!updated.rows[0]) return false;
      await sql.query(
        `UPDATE operador_token SET status = 'REVOGADO', revogado_em = $2
          WHERE operator_id = $1 AND status = 'ATIVO'`,
        [operatorId, now],
      );
      await sql.query(
        `UPDATE operador_sessao SET status = 'REVOGADA', revogada_em = $2
          WHERE operator_id = $1 AND status = 'ATIVA'`,
        [operatorId, now],
      );
      await insertOperatorAudit(sql, operatorId, actorOperatorId, "OPERADOR_SUSPENSO", now);
      return true;
    });
  }
}
