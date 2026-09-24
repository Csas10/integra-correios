import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NodePostgresPool,
  OperatorAdminContinuityError,
  PostgresOperatorIdentityRepository,
} from "../src/index.js";

const temBanco = Boolean(process.env.DATABASE_URL);
const d = temBanco && process.platform !== "win32" ? describe : describe.skip;

const MIGRATIONS = [
  "database/migrations/0001_operational_persistence.sql",
  "database/migrations/0002_runtime_roles.sql",
  "database/migrations/0003_batch_mode_dry_run.sql",
  "database/migrations/0004_oauth_flow.sql",
  "database/migrations/0005_oauth_flow_pkce.sql",
  "database/migrations/0006_operator_identity.sql",
] as const;

let databaseUrlTeste = "";
let databaseNomeTeste = "";

function urlBanco(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function criarBancoEfemero(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  databaseNomeTeste = `integra_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const admin = new NodePostgresPool({
    connectionString: urlBanco(process.env.DATABASE_URL, "postgres"),
  });
  try {
    await admin.query(`CREATE DATABASE "${databaseNomeTeste}"`);
  } finally {
    await admin.close();
  }

  databaseUrlTeste = urlBanco(process.env.DATABASE_URL, databaseNomeTeste);
  const pool = new NodePostgresPool({ connectionString: databaseUrlTeste });
  try {
    for (const migration of MIGRATIONS) {
      await pool.query(await readFile(migration, "utf8"));
    }
  } finally {
    await pool.close();
  }
}

async function destruirBancoEfemero(): Promise<void> {
  if (!process.env.DATABASE_URL || !databaseNomeTeste) return;
  const admin = new NodePostgresPool({
    connectionString: urlBanco(process.env.DATABASE_URL, "postgres"),
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseNomeTeste}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

beforeAll(criarBancoEfemero);
afterAll(destruirBancoEfemero);

d("bootstrap produtivo do primeiro ADMIN_TECNICO", () => {
  it("cria exatamente um administrador auditado e recusa definitivamente a segunda execução", async () => {
    const dir = mkdtempSync(join(tmpdir(), "integra-bootstrap-admin-"));
    const firstArtifact = join(dir, "first.operator-credential.json");
    const secondArtifact = join(dir, "second.operator-credential.json");
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

    const first = spawnSync(
      npmCommand,
      [
        "run",
        "operator:bootstrap-admin",
        "--",
        "--code",
        "ADMIN-INICIAL",
        "--name",
        "Administrador Inicial Sintético",
        "--out",
        firstArtifact,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrlTeste },
        encoding: "utf8",
        timeout: 120000,
      },
    );

    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(firstArtifact)).toBe(true);
    const artifact = JSON.parse(readFileSync(firstArtifact, "utf8")) as {
      credential: string;
      credentialHash: string;
    };
    expect(first.stdout).toContain(artifact.credentialHash);
    expect(first.stdout).not.toContain(artifact.credential);
    expect(first.stderr).not.toContain(artifact.credential);

    const pool = new NodePostgresPool({ connectionString: databaseUrlTeste });
    try {
      const state = await pool.query<{
        operator_id: string;
        papel: string;
        token_hash: string;
        audit_type: string;
      }>(
        `SELECT
           o.id AS operator_id,
           p.papel,
           t.token_hash,
           ea.tipo AS audit_type
         FROM operador o
         JOIN operador_papel p ON p.operator_id = o.id AND p.ativo = true
         JOIN operador_token t ON t.operator_id = o.id AND t.status = 'ATIVO'
         JOIN evento_auditoria ea
           ON ea.operator_id = o.id
          AND ea.ator_operator_id = o.id
        WHERE o.status = 'ATIVO'`,
      );
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]?.papel).toBe("ADMIN_TECNICO");
      expect(state.rows[0]?.token_hash).toBe(artifact.credentialHash);
      expect(state.rows[0]?.audit_type).toBe("ADMIN_BOOTSTRAP_INICIAL");

      const initialAdminId = state.rows[0]!.operator_id;
      const repository = new PostgresOperatorIdentityRepository(pool);
      await expect(repository.suspendOperator(
        initialAdminId,
        initialAdminId,
        new Date().toISOString(),
      )).rejects.toBeInstanceOf(OperatorAdminContinuityError);

      const stillActive = await pool.query<{ status: string }>(
        "SELECT status FROM operador WHERE id = $1",
        [initialAdminId],
      );
      expect(stillActive.rows[0]?.status).toBe("ATIVO");
    } finally {
      await pool.close();
    }

    const second = spawnSync(
      npmCommand,
      [
        "run",
        "operator:bootstrap-admin",
        "--",
        "--code",
        "ADMIN-SEGUNDO",
        "--name",
        "Segundo Administrador Sintético",
        "--out",
        secondArtifact,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrlTeste },
        encoding: "utf8",
        timeout: 120000,
      },
    );

    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("já existe operador");
    expect(existsSync(secondArtifact)).toBe(false);

    const verify = new NodePostgresPool({ connectionString: databaseUrlTeste });
    try {
      const totals = await verify.query<{ operators: number; bootstrap_events: number }>(
        `SELECT
          (SELECT count(*)::int FROM operador) AS operators,
          (SELECT count(*)::int FROM evento_auditoria
            WHERE tipo = 'ADMIN_BOOTSTRAP_INICIAL') AS bootstrap_events`,
      );
      expect(totals.rows[0]?.operators).toBe(1);
      expect(totals.rows[0]?.bootstrap_events).toBe(1);
    } finally {
      await verify.close();
    }
  }, 30000);
});
