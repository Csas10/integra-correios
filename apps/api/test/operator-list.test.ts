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

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-02.1 — TEST-ONLY: busca pagination-aware de um operador
// sintético pelo código. A listagem administrativa é paginada POR CONTRATO
// (ORDER BY o.criado_em, o.id + LIMIT/OFFSET): um operador recém-provisionado
// NÃO tem garantia contratual de pertencer à página 1 — múltiplos arquivos de
// teste criam operadores sintéticos no MESMO banco do quality-gate
// (FRESH_POSTGRES_PER_RUN=true; o acúmulo é INTRA-run). Este helper percorre
// a paginação EXISTENTE pela PRÓPRIA API administrativa (nenhuma consulta
// direta ao PostgreSQL para contornar a API; nenhum endpoint novo de busca em
// produção; nenhum mudança de ordenação). Teto de 20 páginas é SEGURANÇA DE
// TESTE apenas — nenhum limite de produção é alterado.
//
// ADMIN_OPERATOR_UI_PAGINATION_DEBT....... DEFER_POST_CANARY
// (limitação da UI com >100 operadores; fora do escopo deste fechamento —
// nenhuma evidência de que o canário controlado dependa de >100 operadores.)
// ---------------------------------------------------------------------------
const PAGINA_TAMANHO = 100;
const PAGINAS_TETO_SEGURANCA = 20; // 20 × 100 = 2000 entradas (só teste)

async function buscarOperadorPorCodigo(
  adminCookie: string,
  code: string,
): Promise<Record<string, unknown> | undefined> {
  for (let pagina = 0; pagina < PAGINAS_TETO_SEGURANCA; pagina += 1) {
    const offset = pagina * PAGINA_TAMANHO;
    const resposta = await despachar(
      "GET",
      `/api/operator/admin/operators?limit=${PAGINA_TAMANHO}&offset=${offset}`,
      { headers: { cookie: adminCookie } },
    );
    expect(resposta.status, `listagem paginada (offset=${offset}) deve responder 200`).toBe(200);
    const paginados = JSON.parse(resposta.corpo) as { operadores: Record<string, unknown>[] };
    const entry = paginados.operadores.find((o) => o["code"] === code);
    if (entry !== undefined) return entry;
    // Última página: nada mais a percorrer.
    if (paginados.operadores.length < PAGINA_TAMANHO) return undefined;
  }
  // Teto de segurança atingido (paginação não terminou dentro do teto).
  return undefined;
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
  async function bootstrapAdmin(): Promise<{ readonly cookie: string; readonly codigo: string }> {
    const operatorId = randomUUID();
    const tokenId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 12);
    const codigo = `ADMIN-${suffix}`;
    const rawCredential = `AdminList_${"abcdefghijklmnopqrstuvwxyz0123456789"}${suffix}`;
    const now = new Date().toISOString();
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DATABASE_URL_AMBIENTE! });
    try {
      await pool.query(
        `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
         VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [operatorId, codigo, "Administrador Listagem", now],
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
    return { cookie: firstCookie(login.headers["set-cookie"]), codigo };
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
    const admin = await bootstrapAdmin();
    const adminCookie = admin.cookie;
    const preparador = await provisionar(adminCookie, "ui-preparador", ["PREPARADOR"]);
    const aprovador = await provisionar(adminCookie, "ui-aprovador", ["APROVADOR"]);

    const resposta = await despachar("GET", `/api/operator/admin/operators?limit=${PAGINA_TAMANHO}`, {
      headers: { cookie: adminCookie },
    });
    expect(resposta.status).toBe(200);
    const parsed = JSON.parse(resposta.corpo) as { operadores: Record<string, unknown>[] };

    // GF-3 CORRECTIVE-02.1 — localização pagination-aware (o operador criado
    // NÃO tem garantia contratual de estar na página 1). Os operadores
    // PRECISAM ser encontrados até a página terminal — senão o teste FALHA:
    const preparadorEntry = await buscarOperadorPorCodigo(adminCookie, "ui-preparador");
    const aprovadorEntry = await buscarOperadorPorCodigo(adminCookie, "ui-aprovador");
    expect(preparadorEntry, "ui-preparador deve existir na listagem paginada").toBeDefined();
    expect(aprovadorEntry, "ui-aprovador deve existir na listagem paginada").toBeDefined();

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

    // administrador enxerga a si mesmo (pagination-aware também)
    const adminEntry = await buscarOperadorPorCodigo(adminCookie, admin.codigo);
    expect(adminEntry, "administrador deve enxergar a si mesmo na listagem").toBeDefined();
  });

  it("recusa usuário sem ADMIN_TECNICO (403 OPERATOR_ROLE_FORBIDDEN)", async () => {
    const { cookie: adminCookie } = await bootstrapAdmin();
    const preparador = await provisionar(adminCookie, "ui-preparador-2", ["PREPARADOR"]);
    const resposta = await despachar("GET", "/api/operator/admin/operators", {
      headers: { cookie: preparador.cookie },
    });
    expect(resposta.status).toBe(403);
    expect(resposta.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");
  });

  it("paginação inválida com admin → 422", async () => {
    const { cookie: adminCookie } = await bootstrapAdmin();
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=NaN"]) {
      const resposta = await despachar("GET", `/api/operator/admin/operators?${query}`, {
        headers: { cookie: adminCookie },
      });
      expect(resposta.status).toBe(422);
      expect(resposta.corpo).toContain("OPERATOR_LIST_INVALID_PAGINATION");
    }
  });

  it("ciclo provisionar → suspender → recuperar reflete estados agregados na listagem", async () => {
    const { cookie: adminCookie } = await bootstrapAdmin();
    const alvo = await provisionar(adminCookie, "ui-temporario", ["EXECUTOR"]);

    // GF-3 CORRECTIVE-02.1 — localização pagination-aware; o operador criado
    // PRECISA ser encontrado (senão o teste falha com diagnóstico claro) e
    // TODAS as expectativas de ciclo permanecem INTEGROS (nada opcionalizado):
    let entry = await buscarOperadorPorCodigo(adminCookie, "ui-temporario");
    expect(entry, "ui-temporario (pós-provisionamento) deve existir na listagem paginada").toBeDefined();
    expect(entry?.["status"]).toBe("ATIVO");
    expect(entry?.["credentialState"]).toBe("ATIVA");
    expect(entry?.["activeSessions"]).toBe(1);

    await despachar("POST", "/api/operator/admin/suspend", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ operatorId: alvo.operatorId })),
    });
    entry = await buscarOperadorPorCodigo(adminCookie, "ui-temporario");
    expect(entry, "ui-temporario (pós-suspensão) deve existir na listagem paginada").toBeDefined();
    expect(entry?.["status"]).toBe("SUSPENSO");
    expect(entry?.["credentialState"]).toBe("INDEFINIDA");
    expect(entry?.["activeSessions"]).toBe(0);

    // Contrato real: recover exige operador ATIVO — sobre SUSPENSO responde
    // 404 OPERATOR_NOT_ACTIVE e não reativa (reativação é outra decisão).
    const recuperacaoRecusada = await despachar("POST", "/api/operator/admin/credentials/recover", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        operatorId: alvo.operatorId,
        credentialHash: sha(`Rec_${randomUUID()}`),
      })),
    });
    expect(recuperacaoRecusada.status).toBe(404);
    expect(recuperacaoRecusada.corpo).toContain("OPERATOR_NOT_ACTIVE");

    // Rotação em operador ATIVO troca a credencial mantendo o estado.
    const rotacionada = await provisionar(adminCookie, "ui-temporario-2", ["EXECUTOR"]);
    await despachar("POST", "/api/operator/admin/credentials/rotate", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        operatorId: rotacionada.operatorId,
        credentialHash: sha(`Rot_${randomUUID()}`),
      })),
    });
    entry = await buscarOperadorPorCodigo(adminCookie, "ui-temporario-2");
    expect(entry, "ui-temporario-2 (pós-rotação) deve existir na listagem paginada").toBeDefined();
    expect(entry?.["status"]).toBe("ATIVO");
    expect(entry?.["credentialState"]).toBe("ATIVA");
    expect(entry?.["activeSessions"]).toBe(0); // sessões revogadas na rotação
  });

  it("proteção do último administrador e da auto-suspensão → 409 OPERATOR_ADMIN_CONTINUITY_REQUIRED", async () => {
    const { cookie: adminCookie } = await bootstrapAdmin();
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
    const { cookie: adminCookie } = await bootstrapAdmin();
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } })).status).toBe(200);
    await despachar("DELETE", "/api/operator/identity/session", { headers: { cookie: adminCookie } });
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie: adminCookie } })).status).toBe(401);
  });
});

afterEach(() => {
  // limpezas futuras sem alterar o contrato atual
});
