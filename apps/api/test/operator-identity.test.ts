import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NodePostgresPool } from "@integra-correios/persistence";
import { despachar } from "../src/server.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const ORIGINAL_OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;

const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function firstCookie(header: string | undefined): string {
  return header?.split("\n")[0]?.split(";")[0] ?? "";
}

async function bootstrapAdmin(): Promise<{
  operatorId: string;
  rawCredential: string;
  cookie: string;
}> {
  const operatorId = randomUUID();
  const tokenId = randomUUID();
  const suffix = operatorId.replace(/-/g, "").slice(0, 12);
  const rawCredential = `AdminIndividual_abcdefghijklmnopqrstuvwxyz0123456789${suffix}`;
  const now = new Date().toISOString();
  const pool = new NodePostgresPool({ connectionString: DATABASE_URL! });
  try {
    await pool.query(
      `INSERT INTO operador (
        id, codigo, nome_exibicao, status, criado_em, atualizado_em
      ) VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
      [operatorId, `ADMIN-${suffix}`, "Administrador Individual Sintético", now],
    );
    await pool.query(
      `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
       VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
      [operatorId, now],
    );
    await pool.query(
      `INSERT INTO operador_token (
        id, operator_id, token_hash, emitido_por_operator_id, status, criado_em
      ) VALUES ($1, $2, $3, $2, 'ATIVO', $4)`,
      [tokenId, operatorId, sha(rawCredential), now],
    );
  } finally {
    await pool.close();
  }

  const login = await despachar("POST", "/api/operator/identity/session", {
    headers: { "content-type": "application/json" },
    corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
  });
  expect(login.status).toBe(200);
  return { operatorId, rawCredential, cookie: firstCookie(login.headers["set-cookie"]) };
}

async function provisionOperator(
  adminCookie: string,
  rawCredential: string,
  roles: string[] = ["PREPARADOR"],
): Promise<string> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const response = await despachar("POST", "/api/operator/admin/provision", {
    headers: { cookie: adminCookie, "content-type": "application/json" },
    corpo: Buffer.from(JSON.stringify({
      code: `OP-${suffix}`,
      displayName: `Operador ${suffix}`,
      roles,
      credentialHash: sha(rawCredential),
    })),
  });
  expect(response.status).toBe(201);
  expect(response.corpo).not.toContain(rawCredential);
  return (JSON.parse(response.corpo) as { operatorId: string }).operatorId;
}

async function login(rawCredential: string): Promise<string> {
  const response = await despachar("POST", "/api/operator/identity/session", {
    headers: { "content-type": "application/json" },
    corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
  });
  expect(response.status).toBe(200);
  return firstCookie(response.headers["set-cookie"]);
}

afterEach(() => {
  if (ORIGINAL_OPERATOR_TOKEN === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = ORIGINAL_OPERATOR_TOKEN;
});

describeDb("Ciclo administrativo individual — API E2E", () => {
  it("Bearer legado não provisiona, suspende, rotaciona nem recupera credenciais", async () => {
    process.env.OPERATOR_TOKEN = "legacy-admin-token-must-not-authorize";
    const headers = {
      authorization: "Bearer legacy-admin-token-must-not-authorize",
      "content-type": "application/json",
    };

    expect((await despachar("POST", "/api/operator/admin/provision", {
      headers,
      corpo: Buffer.from(JSON.stringify({
        code: "LEGACY",
        displayName: "Legacy",
        roles: ["PREPARADOR"],
        credentialHash: "a".repeat(64),
      })),
    })).status).toBe(401);

    for (const path of [
      "/api/operator/admin/suspend",
      "/api/operator/admin/credentials/rotate",
      "/api/operator/admin/credentials/recover",
    ]) {
      expect((await despachar("POST", path, {
        headers,
        corpo: Buffer.from(JSON.stringify({
          operatorId: randomUUID(),
          credentialHash: "b".repeat(64),
        })),
      })).status).toBe(401);
    }
  });

  it("ADMIN_TECNICO individual provisiona e suspende com autoria persistida", async () => {
    const admin = await bootstrapAdmin();
    const rawCredential = `Target_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    const operatorId = await provisionOperator(admin.cookie, rawCredential, ["PREPARADOR", "REVISOR"]);
    const operatorCookie = await login(rawCredential);

    expect((await despachar("GET", "/api/operator/me", {
      headers: { cookie: operatorCookie },
    })).status).toBe(200);

    const suspend = await despachar("POST", "/api/operator/admin/suspend", {
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ operatorId })),
    });
    expect(suspend.status).toBe(200);
    expect((JSON.parse(suspend.corpo) as { performedBy: string }).performedBy).toBe(admin.operatorId);
    expect((await despachar("GET", "/api/operator/me", {
      headers: { cookie: operatorCookie },
    })).status).toBe(401);

    const pool = new NodePostgresPool({ connectionString: DATABASE_URL! });
    try {
      const audit = await pool.query<{
        tipo: string;
        ator_id: string;
        ator_operator_id: string;
      }>(
        `SELECT tipo, ator_id, ator_operator_id
           FROM evento_auditoria
          WHERE operator_id = $1
            AND tipo IN ('OPERADOR_PROVISIONADO','OPERADOR_SUSPENSO')
          ORDER BY sequencia`,
        [operatorId],
      );
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows.every((row) =>
        row.ator_id === admin.operatorId &&
        row.ator_operator_id === admin.operatorId
      )).toBe(true);
    } finally {
      await pool.close();
    }
  });

  it("rotação revoga credencial e sessões antigas e ativa somente o novo hash", async () => {
    const admin = await bootstrapAdmin();
    const oldCredential = `RotateOld_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    const newCredential = `RotateNew_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    const operatorId = await provisionOperator(admin.cookie, oldCredential);
    const oldCookie = await login(oldCredential);

    const rotate = await despachar("POST", "/api/operator/admin/credentials/rotate", {
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        operatorId,
        credentialHash: sha(newCredential),
      })),
    });
    expect(rotate.status).toBe(200);
    expect(rotate.corpo).not.toContain(newCredential);
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie: oldCookie } })).status).toBe(401);

    const oldLogin = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: oldCredential })),
    });
    expect(oldLogin.status).toBe(401);
    expect((await despachar("GET", "/api/operator/me", {
      headers: { cookie: await login(newCredential) },
    })).status).toBe(200);
  });

  it("recuperação substitui a credencial sem revelar a anterior ou a nova", async () => {
    const admin = await bootstrapAdmin();
    const lostCredential = `RecoverOld_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    const replacement = `RecoverNew_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    const operatorId = await provisionOperator(admin.cookie, lostCredential);

    const recover = await despachar("POST", "/api/operator/admin/credentials/recover", {
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        operatorId,
        credentialHash: sha(replacement),
      })),
    });
    expect(recover.status).toBe(200);
    expect(recover.corpo).not.toContain(lostCredential);
    expect(recover.corpo).not.toContain(replacement);

    expect((await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: lostCredential })),
    })).status).toBe(401);
    expect((await despachar("GET", "/api/operator/me", {
      headers: { cookie: await login(replacement) },
    })).status).toBe(200);
  });

  it("operador sem ADMIN_TECNICO recebe 403 nas ações administrativas", async () => {
    const admin = await bootstrapAdmin();
    const rawCredential = `PrepOnly_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().slice(0, 8)}`;
    await provisionOperator(admin.cookie, rawCredential, ["PREPARADOR"]);
    const cookie = await login(rawCredential);

    expect((await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "DENIED",
        displayName: "Denied",
        roles: ["PREPARADOR"],
        credentialHash: "a".repeat(64),
      })),
    })).status).toBe(403);
  });
});
