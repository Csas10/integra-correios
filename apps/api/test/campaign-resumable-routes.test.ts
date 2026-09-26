import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { despachar as despacharSemBanco } from "../src/server.js";

type Despachar = typeof despacharSemBanco;
let despacharAtivo: Despachar = despacharSemBanco;

async function despachar(
  metodo: string,
  caminho: string,
  opcoes: { headers?: Record<string, string>; corpo?: Buffer } = {},
): ReturnType<Despachar> {
  return despacharAtivo(metodo, caminho, opcoes);
}

const DB_URL_AMBIENTE = process.env.DATABASE_URL;

afterAll(() => {
  if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DB_URL_AMBIENTE;
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function firstCookie(header: string | undefined): string {
  return header?.split("\n")[0]?.split(";")[0] ?? "";
}

describe("CAMPAIGN_RESUMABLE_ROUTES — fail-closed (sem banco)", () => {
  beforeAll(() => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
  });

  it("sem credencial → 401/403/503, nunca revela modo", async () => {
    const resposta = await despachar("GET", "/api/campaigns/resumable", {});
    expect([401, 403, 503]).toContain(resposta.status);
    expect(resposta.corpo).not.toContain("EMPTY");
    expect(resposta.corpo).not.toContain("SINGLE");
    expect(resposta.corpo).not.toContain("MULTIPLE");
  });
});

const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

describeDb("CAMPAIGN_RESUMABLE_ROUTES — retomada real (PostgreSQL 16)", () => {
  const ORIGINAL_ENV = {
    persist: process.env.PF_CAMPAIGN_PERSIST_ENABLED,
    batch: process.env.PF_CAMPAIGN_BATCH_ENABLED,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
    process.env.PF_CAMPAIGN_PERSIST_ENABLED = "true";
    process.env.PF_CAMPAIGN_BATCH_ENABLED = "true";
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despacharAtivo = servidor.despachar;
  });

  afterAll(() => {
    if (ORIGINAL_ENV.persist === undefined) delete process.env.PF_CAMPAIGN_PERSIST_ENABLED;
    else process.env.PF_CAMPAIGN_PERSIST_ENABLED = ORIGINAL_ENV.persist;
    if (ORIGINAL_ENV.batch === undefined) delete process.env.PF_CAMPAIGN_BATCH_ENABLED;
    else process.env.PF_CAMPAIGN_BATCH_ENABLED = ORIGINAL_ENV.batch;
  });

  async function bootstrapAdmin(): Promise<string> {
    const operatorId = randomUUID();
    const tokenId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 12);
    const rawCredential = `AdminIndividual_abcdefghijklmnopqrstuvwxyz0123456789${suffix}`;
    const now = new Date().toISOString();
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    try {
      await pool.query(
        `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
         VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [operatorId, `ADMIN-${suffix}`, "Administrador Individual Sintético", now],
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

  async function provisionOperator(
    adminCookie: string,
    roles: string[],
  ): Promise<{ operatorId: string; cookie: string }> {
    const rawCredential = `Op_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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
    const operatorId = (JSON.parse(response.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
    });
    expect(login.status).toBe(200);
    return { operatorId, cookie: firstCookie(login.headers["set-cookie"]) };
  }

  const REGISTROS = [
    { profissional_id: "PF-R-0001", nome: "Ana Sintetica", email_normalizado: "ana@exemplo.test", status_validacao: "APTO" },
    { profissional_id: "PF-R-0002", nome: "Bruno Sintetico", email_normalizado: "bruno@exemplo.test", status_validacao: "APTO" },
  ];

  async function persistirCampanha(cookie: string, fingerprint: string) {
    const resposta = await despachar("POST", "/api/campaigns/persist", {
      headers: { cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        fingerprintArquivo: fingerprint,
        registros: REGISTROS,
        decisoes: [],
      })),
    });
    expect(resposta.status).toBe(201);
    return JSON.parse(resposta.corpo) as { campanhaId: string; conteudoHash: string };
  }

  it("EMPTY → SINGLE APROVADA → SINGLE LOTE_CRIADO/HOLD, com delta zero nas leituras", async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    const fingerprint = sha(`resumavel-${randomUUID()}`);
    try {
      const adminCookie = await bootstrapAdmin();
      const dono = await provisionOperator(adminCookie, ["PREPARADOR", "APROVADOR", "EXECUTOR"]);

      // 0. ZERO campanhas retomáveis → EMPTY explícito.
      const vazia = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: dono.cookie } });
      expect(vazia.status).toBe(200);
      const corpoVazio = JSON.parse(vazia.corpo) as { mode: string; campaigns: unknown[] };
      expect(corpoVazio.mode).toBe("EMPTY");
      expect(corpoVazio.campaigns).toEqual([]);

      // 1. UMA campanha APROVADA (sem lote) → SINGLE, sem hash do cliente.
      const alvo = await persistirCampanha(dono.cookie, fingerprint);
      const aprovada = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: dono.cookie } });
      expect(aprovada.status).toBe(200);
      const corpoAprovada = JSON.parse(aprovada.corpo) as {
        mode: string;
        campaign: { campanhaId: string; estado: string; loteId: string | null };
      };
      expect(corpoAprovada.mode).toBe("SINGLE");
      expect(corpoAprovada.campaign.campanhaId).toBe(alvo.campanhaId);
      expect(corpoAprovada.campaign.estado).toBe("APROVADA");
      expect(corpoAprovada.campaign.loteId).toBeNull();
      expect(aprovada.corpo).not.toMatch(/token_hash|set-cookie|session_hash/i);

      // 2. Delta zero: leitura não muta campanha nem fila produtiva.
      const contagem = async (): Promise<Record<string, string>> => {
        const resultado = await pool.query<{ tabela: string; total: string }>(
          `SELECT 'campanha_persistida' AS tabela, count(*)::text AS total FROM campanha_persistida WHERE id = $1
           UNION ALL SELECT 'lote_campanha', count(*)::text FROM lote_campanha WHERE campanha_id = $1
           UNION ALL SELECT 'outbox_campanha', count(*)::text FROM outbox_campanha o
             JOIN lote_campanha lc ON lc.id = o.lote_campanha_id WHERE lc.campanha_id = $1
           UNION ALL SELECT 'evento_auditoria', count(*)::text FROM evento_auditoria
             WHERE agregado_tipo = 'CAMPANHA_PERSISTIDA' AND agregado_id = $1
           UNION ALL SELECT 'outbox_email', count(*)::text FROM outbox_email
           UNION ALL SELECT 'comunicacao', count(*)::text FROM comunicacao
           UNION ALL SELECT 'lote_comunicacao', count(*)::text FROM lote_comunicacao`,
          [alvo.campanhaId],
        );
        return Object.fromEntries(resultado.rows.map((r) => [r.tabela, r.total]));
      };
      const antes = await contagem();
      await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: dono.cookie } });
      await despachar("GET", `/api/campaigns/detail?campanhaId=${alvo.campanhaId}`, { headers: { cookie: dono.cookie } });
      const depois = await contagem();
      expect(depois).toEqual(antes);

      // 3. UMA campanha LOTE_CRIADO/HOLD → SINGLE com lote.
      const loteCriado = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: dono.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: alvo.campanhaId,
          conteudoHash: alvo.conteudoHash,
        })),
      });
      expect(loteCriado.status).toBe(201);
      expect((JSON.parse(loteCriado.corpo) as { lote: { estado: string } }).lote.estado).toBe("HOLD");
      const comLote = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: dono.cookie } });
      const corpoLote = JSON.parse(comLote.corpo) as {
        mode: string;
        campaign: { estado: string; loteEstado: string | null; outboxTotal: number; outboxNaoExecutavel: number };
      };
      expect(corpoLote.mode).toBe("SINGLE");
      expect(corpoLote.campaign.estado).toBe("LOTE_CRIADO");
      expect(corpoLote.campaign.loteEstado).toBe("HOLD");
      expect(corpoLote.campaign.outboxTotal).toBe(2);
      expect(corpoLote.campaign.outboxNaoExecutavel).toBe(2);
    } finally {
      await pool.close();
    }
  });

  it("MULTIPLE: duas campanhas → resumos autorizados, NENHUMA seleção implícita; detail por seleção explícita; alheio 404 sanitizado", async () => {
    try {
      const adminCookie = await bootstrapAdmin();
      const dono = await provisionOperator(adminCookie, ["PREPARADOR", "EXECUTOR"]);
      const outro = await provisionOperator(adminCookie, ["PREPARADOR", "EXECUTOR"]);

      const primeira = await persistirCampanha(dono.cookie, sha(`multi-1-${randomUUID()}`));
      const segunda = await persistirCampanha(dono.cookie, sha(`multi-2-${randomUUID()}`));

      // DUAS OU MAIS campanhas → MULTIPLE (sem escolha silenciosa).
      const multipla = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: dono.cookie } });
      expect(multipla.status).toBe(200);
      const corpoMulti = JSON.parse(multipla.corpo) as {
        mode: string;
        campaign?: unknown;
        campaigns: { campanhaId: string; estado: string }[];
      };
      expect(corpoMulti.mode).toBe("MULTIPLE");
      expect(corpoMulti.campaign).toBeUndefined();
      expect(corpoMulti.campaigns.map((c) => c.campanhaId).sort()).toEqual(
        [primeira.campanhaId, segunda.campanhaId].sort(),
      );

      // Seleção EXPLÍCITA do próprio operador → detalhe autorizado.
      const detalhe = await despachar(
        "GET",
        `/api/campaigns/detail?campanhaId=${segunda.campanhaId}`,
        { headers: { cookie: dono.cookie } },
      );
      expect(detalhe.status).toBe(200);
      expect((JSON.parse(detalhe.corpo) as { campanha: { campanhaId: string } }).campanha.campanhaId)
        .toBe(segunda.campanhaId);

      // Campanha alheia: AUSENTE da listagem + detalhe 404 sanitizado.
      const alheia = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: outro.cookie } });
      expect(alheia.status).toBe(200);
      const corpoAlheio = JSON.parse(alheia.corpo) as { mode: string; campaigns: unknown[] };
      expect(corpoAlheio.mode).toBe("EMPTY");
      expect(alheia.corpo).not.toContain(primeira.campanhaId);
      expect(alheia.corpo).not.toContain(primeira.conteudoHash);

      const detalheAlheio = await despachar(
        "GET",
        `/api/campaigns/detail?campanhaId=${primeira.campanhaId}`,
        { headers: { cookie: outro.cookie } },
      );
      expect(detalheAlheio.status).toBe(404);
      expect(detalheAlheio.corpo).toContain("CAMPAIGN_PERSISTED_NOT_FOUND");
      expect(detalheAlheio.corpo).not.toContain(primeira.campanhaId);
    } finally {
      // Conexões efêmeras já fechadas nos helpers.
    }
  });

  it("operador suspenso (sessão revogada) → bloqueado; limite inválido → 422", async () => {
    try {
      const adminCookie = await bootstrapAdmin();
      const preparador = await provisionOperator(adminCookie, ["PREPARADOR", "EXECUTOR"]);
      const suspensao = await despachar("POST", "/api/operator/admin/suspend", {
        headers: { cookie: adminCookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ operatorId: preparador.operatorId, motivo: "TESTE_RETOMADA" })),
      });
      expect([200, 201]).toContain(suspensao.status);
      const suspenso = await despachar("GET", "/api/campaigns/resumable", { headers: { cookie: preparador.cookie } });
      expect([401, 403]).toContain(suspenso.status);
      const detalheSuspenso = await despachar(
        "GET",
        `/api/campaigns/detail?campanhaId=${randomUUID()}`,
        { headers: { cookie: preparador.cookie } },
      );
      expect([401, 403]).toContain(detalheSuspenso.status);

      const novo = await provisionOperator(adminCookie, ["PREPARADOR"]);
      const invalida = await despachar("GET", "/api/campaigns/resumable?limite=999", { headers: { cookie: novo.cookie } });
      expect(invalida.status).toBe(422);
      expect(invalida.corpo).toContain("CAMPAIGN_RESUMABLE_INVALID");
      const valida = await despachar("GET", "/api/campaigns/resumable?limite=5", { headers: { cookie: novo.cookie } });
      expect(valida.status).toBe(200);
      expect((JSON.parse(valida.corpo) as { mode: string }).mode).toBe("EMPTY");
    } finally {
      // Conexões efêmeras já fechadas nos helpers.
    }
  });
});
