import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NodePostgresPool,
  PostgresOperatorIdentityRepository,
} from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describeDb("Identidade operacional individual — PostgreSQL 16", () => {
  it("persiste somente hashes e invalida sessão imediatamente após suspensão", async () => {
    const pool = new NodePostgresPool({ connectionString: DATABASE_URL! });
    const repo = new PostgresOperatorIdentityRepository(pool);
    const operatorId = randomUUID();
    const suffix = operatorId.slice(0, 8);
    const rawToken = `AbCDefghijklmnopqrstuvwxyz0123456789_${suffix}XYZ`;
    const rawSession = `Sessaoabcdefghijklmnopqrstuvwxyz0123456789_${suffix}XYZ`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    try {
      await repo.provisionOperator({
        actorOperatorId: operatorId,
        operatorId,
        code: `OP-${suffix}`,
        displayName: "Operador Sintético",
        roles: ["PREPARADOR", "REVISOR"],
        tokenHash: sha(rawToken),
        now: now.toISOString(),
      });
      const identity = await repo.createSessionFromToken({
        tokenHash: sha(rawToken),
        sessionHash: sha(rawSession),
        now: now.toISOString(),
        sessionExpiresAt: expiresAt,
      });
      expect(identity?.operatorId).toBe(operatorId);

      const stored = await pool.query<{
        token_hash: string;
        session_hash: string;
        emitido_por_operator_id: string;
      }>(
        `SELECT t.token_hash, t.emitido_por_operator_id, s.session_hash
           FROM operador_token t JOIN operador_sessao s ON s.token_id = t.id
          WHERE t.operator_id = $1`,
        [operatorId],
      );
      expect(stored.rows[0]?.token_hash).toBe(sha(rawToken));
      expect(stored.rows[0]?.session_hash).toBe(sha(rawSession));
      expect(stored.rows[0]?.emitido_por_operator_id).toBe(operatorId);
      expect(JSON.stringify(stored.rows[0])).not.toContain(rawToken);
      expect(JSON.stringify(stored.rows[0])).not.toContain(rawSession);

      expect(await repo.resolveSession(sha(rawSession), now.toISOString())).toBeDefined();
      expect(await repo.suspendOperator(
        operatorId,
        operatorId,
        new Date(now.getTime() + 1000).toISOString(),
      )).toBe(true);
      expect(await repo.resolveSession(
        sha(rawSession),
        new Date(now.getTime() + 2000).toISOString(),
      )).toBeUndefined();
    } finally {
      await pool.close();
    }
  });

  it("rotação/recuperação revogam tokens e sessões e registram administrador individual", async () => {
    const pool = new NodePostgresPool({ connectionString: DATABASE_URL! });
    const repo = new PostgresOperatorIdentityRepository(pool);
    const adminId = randomUUID();
    const targetId = randomUUID();
    const now = new Date();
    const adminToken = sha(`admin-${adminId}`);
    const oldToken = sha(`old-${targetId}`);
    const newToken = sha(`new-${targetId}`);
    const recoveredToken = sha(`recover-${targetId}`);

    try {
      await repo.provisionOperator({
        actorOperatorId: adminId,
        operatorId: adminId,
        code: `ADMIN-${adminId.slice(0, 8)}`,
        displayName: "Admin Sintético",
        roles: ["ADMIN_TECNICO"],
        tokenHash: adminToken,
        now: now.toISOString(),
      });
      await repo.provisionOperator({
        actorOperatorId: adminId,
        operatorId: targetId,
        code: `TARGET-${targetId.slice(0, 8)}`,
        displayName: "Target Sintético",
        roles: ["PREPARADOR"],
        tokenHash: oldToken,
        now: now.toISOString(),
      });
      const oldSessionHash = sha(`session-${targetId}`);
      await repo.createSessionFromToken({
        tokenHash: oldToken,
        sessionHash: oldSessionHash,
        now: now.toISOString(),
        sessionExpiresAt: new Date(now.getTime() + 3600000).toISOString(),
      });

      expect(await repo.replaceCredential({
        actorOperatorId: adminId,
        operatorId: targetId,
        tokenHash: newToken,
        reason: "ROTACAO",
        now: new Date(now.getTime() + 1000).toISOString(),
      })).toBe(true);
      expect(await repo.resolveSession(
        oldSessionHash,
        new Date(now.getTime() + 2000).toISOString(),
      )).toBeUndefined();

      expect(await repo.replaceCredential({
        actorOperatorId: adminId,
        operatorId: targetId,
        tokenHash: recoveredToken,
        reason: "RECUPERACAO",
        now: new Date(now.getTime() + 3000).toISOString(),
      })).toBe(true);

      const audit = await pool.query<{
        tipo: string;
        ator_operator_id: string;
      }>(
        `SELECT tipo, ator_operator_id
           FROM evento_auditoria
          WHERE operator_id = $1
            AND tipo IN (
              'OPERADOR_PROVISIONADO',
              'OPERADOR_CREDENCIAL_ROTACIONADA',
              'OPERADOR_CREDENCIAL_RECUPERADA'
            )
          ORDER BY sequencia`,
        [targetId],
      );
      expect(audit.rows.map((row) => row.tipo)).toEqual([
        "OPERADOR_PROVISIONADO",
        "OPERADOR_CREDENCIAL_ROTACIONADA",
        "OPERADOR_CREDENCIAL_RECUPERADA",
      ]);
      expect(audit.rows.every((row) => row.ator_operator_id === adminId)).toBe(true);
    } finally {
      await pool.close();
    }
  });
});
