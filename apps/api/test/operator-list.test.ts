import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { despachar as despacharSemBanco } from "../src/server.js";

// Mesmo padrão de campaign-read-routes.test.ts: o pool de PostgreSQL é
// cacheado em escopo de módulo pelo servidor; o bloco DB-gated recarrega
// o módulo após restaurar DATABASE_URL.
type Despachar = typeof despacharSemBanco;
let despacharAtivo: Despachar = despacharSemBanco;

async function despachar(
  metodo: string,
  caminho: string,
  opcoes: { headers?: Record<string, string | undefined>; corpo?: Buffer } = {},
): ReturnType<Despachar> {
  return despacharAtivo(metodo, caminho, opcoes);
}

const DATABASE_URL_AMBIENTE = process.env.DATABASE_URL;

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  if (DATABASE_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DATABASE_URL_AMBIENTE;
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function firstCookie(header: string | undefined): string {
  return header?.split("\n")[0]?.split(";")[0] ?? "";
}

describe("OPERATOR_LIST — recusas fail-closed sem banco", () => {
  it("401 sem sessão e 503 com cookie de formato válido sem identidade disponível", async () => {
    const semSessao = await despachar("GET", "/api/operator/admin/operators");
    expect(semSessao.status).toBe(401);

    const cookieFalso = `__Host-ic_campaign_operator_session=${"B".repeat(43)}`;
    const comSessao = await despachar("GET", "/api/operator/admin/operators", {
      headers: { cookie: cookieFalso },
    });
    expect(comSessao.status).toBe(503);
  });
});

const describeDb = DATABASE_URL_AMBIENTE ? describe : describe.skip;

describeDb("OPERATOR_LIST — contratos completos (PostgreSQL)", () => {
  async function bootstrapAdmin(): Promise<string> {
    const operatorId = randomUUID();
    const tokenId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 12);
    const rawCredential = `AdminList_${"abcdefghijklmnopqrstuvwxyz0123456789"}${suffix}`;
    const now = new Date().toISOString();
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DATABASE_URL_AMBIENTE! });
    try {
      await pool.query(
        `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
         VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [operatorId, `ADMIN-${suffix}`, "Administrador Listagem", now],
      );
      await pool.query(
        `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
         VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
        [operatorId, now],
      );
      await pool.query(
        `INSERT INTO operador_token (id, operator_id, token_hash, emitido_por_operator_id, status, criado_em)
         VALUES ($1, $2, $3, $2, 'ATIVO', $4)`,
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
    return firstCookie(login.headers["set-cookie"]);
  }

  async function provisionar(
    adminCookie: string,
    code: string,
    roles: string[],
  ): Promise<{ operatorId: string; credencial: string; cookie: string }> {
    const credencial = `Op_${"abcdefghijklmnopqrstuvwxyz0123456789"}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const resposta = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code,
        displayName: `Operador ${code}`,
        roles,
        credentialHash: sha(credencial),
      })),
    });
    expect(resposta.status).toBe(201);
    const operatorId = (JSON.parse(resposta.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencial })),
    });
    expect(login.status).toBe(200);
    return { operatorId, credencial, cookie: firstCookie(login.headers["set-cookie"]) };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL_AMBIENTE;
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despacharAtivo = servidor.despachar;
  });

  it("listagem autorizada: ADMIN_TECNICO vê operadores sem nenhum segredo", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionar(adminCookie, "ui-preparador", ["PREPARADOR"]);
    const aprovador = await provisionar(adminCookie, "ui-aprovador", ["APROVADOR"]);

    const resposta = await despachar("GET", "/api/operator/admin/operators?limit=100", {
      headers: { cookie: adminCookie },
    });
    expect(resposta.status).toBe(200);
    const parsed = JSON.parse(resposta.corpo) as { operadores: Record<string, unknown>[] };
    const codigos = parsed.operadores.map((o) => o["code"]);
    expect(codigos).toContain("ui-preparador");
    expect(codigos).toContain("ui-aprovador");

    const chavesPermitidas = new Set([
      "operatorId", "code", "displayName", "status", "roles",
      "criadoEm", "atualizadoEm", "suspensoEm",
      "credentialActive", "credentialExpiresAt", "credentialState", "activeSessions",
    ]);
    for (const entry of parsed.operadores) {
      for (const chave of Object.keys(entry)) {
        expect(chavesPermitidas.has(chave)).toBe(true);
      }
      expect(["ATIVA", "EXPIRADA", "INDEFINIDA", "AUSENTE"]).toContain(entry["credentialState"]);
      expect(entry["status"]).toMatch(/ATIVO|SUSPENSO/);
    }
    expect(resposta.corpo).not.toContain("token_hash");
    expect(resposta.corpo).not.toContain("session_hash");
    expect(resposta.corpo).not.toContain(preparador.credencial);
    expect(resposta.corpo).not.toContain(aprovador.credencial);

    // administrador enxerga a si mesmo
    expect(codigos.some((c) => String(c).startsWith("ADMIN-"))).toBe(true);
  });

  it("recusa usuário sem ADMIN_TECNICO (403 OPERATOR_ROLE_FORBIDDEN)", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionar(adminCookie, "ui-preparador-2", ["PREPARADOR"]);
    const resposta = await despachar("GET", "/api/operator/admin/operators", {
      headers: { cookie: preparador.cookie },
    });
    expect(resposta.status).toBe(403);
    expect(resposta.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");
  });

  it("paginação inválida com admin → 422", async () => {
    const adminCookie = await bootstrapAdmin();
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=NaN"]) {
      const resposta = await despachar("GET", `/api/operator/admin/operators?${query}`, {
        headers: { cookie: adminCookie },
      });
      expect(resposta.status).toBe(422);
      expect(resposta.corpo).toContain("OPERATOR_LIST_INVALID_PAGINATION");
    }
  });

  it("ciclo provisionar → suspender → recuperar reflete estados agregados na listagem", async () => {
    const adminCookie = await bootstrapAdmin();
    const alvo = await provisionar(adminCookie, "ui-temporario", ["EXECUTOR"]);

    let resposta = await despachar("GET", "/api/operator/admin/operators?limit=100", {
      headers: { cookie: adminCookie },
    });
    let entry = (JSON.parse(resposta.corpo) as { operadores: Array<Record<string, unknown>> })
      .operadores.find((o) => o["code"] === "ui-temporario");
    expect(entry?.["status"]).toBe("ATIVO");
    expect(entry?.["credentialState"]).toBe("ATIVA");
    expect(entry?.["activeSessions"]).toBe(1);

    await despachar("POST", "/api/operator/admin/suspend", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ operatorId: alvo.operatorId })),
    });
    resposta = await despachar("GET", "/api/operator/admin/operators?limit=100", {
      headers: { cookie: adminCookie },
    });
    entry = (JSON.parse(resposta.corpo) as { operadores: Array<Record<string, unknown>> })
      .operadores.find((o) => o["code"] === "ui-temporario");
    expect(entry?.["status"]).toBe("SUSPENSO");
    expect(entry?.["credentialState"]).toBe("INDEFINIDA");
    expect(entry?.["activeSessions"]).toBe(0);

    await despachar("POST", "/api/operator/admin/credentials/recover", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        operatorId: alvo.operatorId,
        credentialHash: sha(`Rec_${randomUUID()}`),
      })),
    });
    resposta = await despachar("GET", "/api/operator/admin/operators?limit=100", {
      headers: { cookie: adminCookie },
    });
    entry = (JSON.parse(resposta.corpo) as { operadores: Array<Record<string, unknown>> })
      .operadores.find((o) => o["code"] === "ui-temporario");
    expect(entry?.["status"]).toBe("ATIVO");
    expect(entry?.["credentialState"]).toBe("ATIVA");
  });

  it("proteção do último administrador e da auto-suspensão → 409 OPERATOR_ADMIN_CONTINUITY_REQUIRED", async () => {
    const adminCookie = await bootstrapAdmin();
    const me = await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } });
    expect(me.status).toBe(200);
    const { operatorId } = JSON.parse(me.corpo) as { operatorId: string };

    const resposta = await despachar("POST", "/api/operator/admin/suspend", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ operatorId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("OPERATOR_ADMIN_CONTINUITY_REQUIRED");

    const aindaAtivo = await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } });
    expect(aindaAtivo.status).toBe(200);
  });

  it("logout confirmado revoga a sessão (me 200 → DELETE → me 401)", async () => {
    const adminCookie = await bootstrapAdmin();
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } })).status).toBe(200);
    await despachar("DELETE", "/api/operator/identity/session", { headers: { cookie: adminCookie } });
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } })).status).toBe(401);
  });
});

afterEach(() => {
  // limpezas futuras sem alterar o contrato atual
});
