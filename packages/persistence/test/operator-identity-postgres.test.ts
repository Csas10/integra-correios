import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NodePostgresPool, PostgresOperatorIdentityRepository } from "../src/index.js";

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
      expect(identity?.roles).toEqual(["PREPARADOR", "REVISOR"]);

      const stored = await pool.query<{ token_hash: string; session_hash: string }>(
        `SELECT t.token_hash, s.session_hash
           FROM operador_token t JOIN operador_sessao s ON s.token_id = t.id
          WHERE t.operator_id = $1`, [operatorId],
      );
      expect(stored.rows[0]?.token_hash).toBe(sha(rawToken));
      expect(stored.rows[0]?.session_hash).toBe(sha(rawSession));
      expect(JSON.stringify(stored.rows[0])).not.toContain(rawToken);
      expect(JSON.stringify(stored.rows[0])).not.toContain(rawSession);

      expect(await repo.resolveSession(sha(rawSession), now.toISOString())).toBeDefined();
      expect(await repo.suspendOperator(operatorId, new Date(now.getTime() + 1000).toISOString())).toBe(true);
      expect(await repo.resolveSession(sha(rawSession), new Date(now.getTime() + 2000).toISOString())).toBeUndefined();

      const audit = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM evento_auditoria
          WHERE operator_id = $1
            AND tipo IN ('OPERADOR_PROVISIONADO','OPERADOR_SESSAO_CRIADA','OPERADOR_SUSPENSO')`,
        [operatorId],
      );
      expect(audit.rows[0]?.total).toBe(3);
    } finally {
      await pool.close();
    }
  });
});
