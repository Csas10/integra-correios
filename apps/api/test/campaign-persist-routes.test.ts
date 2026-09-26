import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { despachar as despacharSemBanco } from "../src/server.js";
import { carregarPoliticaCampanhaAtualizacao } from "../src/campaigns.js";

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

// ---------------------------------------------------------------------------
// 1. Fail-closed SEM banco: flags fechadas por padrão e rotas nunca abertas.
// ---------------------------------------------------------------------------

describe("CAMPAIGN_PERSIST_ROUTES — gates fechados (sem banco)", () => {
  beforeAll(() => {
    delete process.env.DATABASE_URL;
    delete process.env.PF_CAMPAIGN_PERSIST_ENABLED;
    delete process.env.PF_CAMPAIGN_BATCH_ENABLED;
    vi.resetModules();
  });

  it("flags default false: canPersistImport/canCreateBatch/canExecute fechados", () => {
    const politica = carregarPoliticaCampanhaAtualizacao({});
    expect(politica.canPersistImport).toBe(false);
    expect(politica.canCreateBatch).toBe(false);
    expect(politica.canExecute).toBe(false);
    expect(politica.phase).toBe("FOUNDATION");
  });

  it("flags explicitamente abertas só com PF_*_ENABLED=true", () => {
    const politica = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_PERSIST_ENABLED: "true",
      PF_CAMPAIGN_BATCH_ENABLED: "true",
    });
    expect(politica.canPersistImport).toBe(true);
    expect(politica.canCreateBatch).toBe(true);
    expect(politica.canExecute).toBe(false);
    expect(politica.phase).toBe("PERSISTENCE");
  });

  it("POST /api/campaigns/persist nunca responde aberto sem credencial", async () => {
    const resposta = await despachar("POST", "/api/campaigns/persist", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({})),
    });
    expect([401, 403, 503]).toContain(resposta.status);
    expect(resposta.corpo).not.toContain("CAMPAIGN_PERSISTED");
  });
});

// ---------------------------------------------------------------------------
// 2. Bloco DB-gated (CI / PostgreSQL 16): jornada real com fixtures.
//    Localmente é skipped — skip por ausência de DATABASE_URL NÃO é PASS.
// ---------------------------------------------------------------------------

const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

describeDb("CAMPAIGN_PERSIST_ROUTES — jornada persistida real (PostgreSQL)", () => {
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
    { profissional_id: "PF-P-0001", nome: "Ana Sintetica", email_normalizado: "ana@exemplo.test", status_validacao: "APTO" },
    { profissional_id: "PF-P-0002", nome: "Bruno Sintetico", email_normalizado: "bruno@exemplo.test", status_validacao: "APTO" },
    { profissional_id: "PF-P-0003", nome: "Carla Sintetica", email_normalizado: "carla@exemplo.test", status_validacao: "APTO" },
  ];

  it("jornada: gate 403 → persist → stale 409 → idempotência → batch EXECUTOR → outbox HOLD → zero-claim", async () => {
    const { NodePostgresPool, PostgresOperationalRepository } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    const fingerprint = sha(`fingerprint-sintetico-${randomUUID()}`);
    const decisoesTeste = [{ linha: 99, profissional_id: "PF-P-0009", tipo: "EXCLUSAO_HUMANA", motivo: "TESTE" }];
    // Delta da fila produtiva (padrão zero-escrita do repo): a CI compartilha
    // o banco entre suítes — a prova é antes/depois, não contagem absoluta.
    const contagemFila = async (): Promise<Record<string, string>> => {
      const resultado = await pool.query<{ tabela: string; total: string }>(
        `SELECT 'outbox_email' AS tabela, count(*)::text AS total FROM outbox_email
         UNION ALL SELECT 'comunicacao', count(*)::text FROM comunicacao
         UNION ALL SELECT 'lote_comunicacao', count(*)::text FROM lote_comunicacao
         UNION ALL SELECT 'item_lote_comunicacao', count(*)::text FROM item_lote_comunicacao`,
      );
      return Object.fromEntries(resultado.rows.map((r) => [r.tabela, r.total]));
    };
    const antesFila = await contagemFila();
    try {
      const adminCookie = await bootstrapAdmin();
      const operador = await provisionOperator(adminCookie, ["PREPARADOR", "EXECUTOR"]);
      const revisor = await provisionOperator(adminCookie, ["REVISOR"]);

      // RBAC de gate: com flags fechadas, persist recusa mesmo autenticado
      process.env.PF_CAMPAIGN_PERSIST_ENABLED = "false";
      const negado = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: [],
        })),
      });
      expect(negado.status).toBe(403);
      expect(negado.corpo).toContain("CAMPAIGN_PERSIST_DISABLED");
      process.env.PF_CAMPAIGN_PERSIST_ENABLED = "true";

      // 1. persist (identidade única PREPARADOR+EXECUTOR): 201 CRIADA
      const persistida = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: decisoesTeste,
        })),
      });
      expect(persistida.status).toBe(201);
      const corpoPersist = JSON.parse(persistida.corpo) as {
        campanhaId: string;
        conteudoHash: string;
        status: string;
      };
      expect(corpoPersist.status).toBe("CAMPAIGN_PERSISTED");
      const hashEsperado = createHash("sha256")
        .update("template:pf-atualizacao-cadastral-2026-v1\n")
        .update(
          REGISTROS.map(
            (r) => `${r.profissional_id}\u001f${r.nome}\u001f${r.email_normalizado}\u001f${r.status_validacao}\n`,
          ).join(""),
        )
        .digest("hex");
      expect(corpoPersist.conteudoHash).toBe(hashEsperado);

      // 2. stale: conteúdo divergente com hash antigo → 409
      const stale = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: randomUUID().replace(/-/g, "").padEnd(64, "0"),
          registros: [{ ...REGISTROS[0]!, nome: "CONTEUDO DIVERGENTE" }],
          decisoes: [],
          conteudoHash: corpoPersist.conteudoHash,
        })),
      });
      expect(stale.status).toBe(409);
      expect(stale.corpo).toContain("CAMPAIGN_APPROVAL_STALE");

      // 3. idempotência: mesma submissão → 200 EXISTENTE, nada duplicado
      const repetida = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: decisoesTeste,
        })),
      });
      expect(repetida.status).toBe(200);
      expect(JSON.parse(repetida.corpo).status).toBe("CAMPAIGN_ALREADY_PERSISTED");

      // 4. recuperação pelo hash (etapa 10 pós-reload)
      const recuperada = await despachar(
        "GET",
        `/api/campaigns/persisted?hash=${encodeURIComponent(corpoPersist.conteudoHash)}`,
        { headers: { cookie: operador.cookie } },
      );
      expect(recuperada.status).toBe(200);
      const campanha = (JSON.parse(recuperada.corpo) as {
        campanha: { campanhaId: string; totalAprovados: number; estado: string; outboxTotal: number };
      }).campanha;
      expect(campanha.campanhaId).toBe(corpoPersist.campanhaId);
      expect(campanha.estado).toBe("APROVADA");
      expect(campanha.outboxTotal).toBe(0);

      // 5. batch sem EXECUTOR → 403 ROLE
      const loteSemPapel = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: revisor.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: corpoPersist.campanhaId,
          conteudoHash: corpoPersist.conteudoHash,
        })),
      });
      expect(loteSemPapel.status).toBe(403);
      expect(loteSemPapel.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");

      // 6. batch pelo próprio operador (EXECUTOR) → 201, lote HOLD + outbox NÃO capturável
      const loteCriado = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: corpoPersist.campanhaId,
          conteudoHash: corpoPersist.conteudoHash,
        })),
      });
      expect(loteCriado.status).toBe(201);
      const lote = JSON.parse(loteCriado.corpo) as {
        lote: { estado: string; totalItens: number; outboxTotal: number; outboxNaoExecutavel: number };
        executavel: boolean;
      };
      expect(lote.lote.estado).toBe("HOLD");
      expect(lote.executavel).toBe(false);
      expect(lote.lote.totalItens).toBe(3);
      expect(lote.lote.outboxTotal).toBe(3);
      expect(lote.lote.outboxNaoExecutavel).toBe(3);

      // 7. idempotência do lote → 200 EXISTENTE
      const loteRepetido = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: operador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: corpoPersist.campanhaId,
          conteudoHash: corpoPersist.conteudoHash,
        })),
      });
      expect(loteRepetido.status).toBe(200);
      expect(JSON.parse(loteRepetido.corpo).status).toBe("CAMPAIGN_BATCH_ALREADY_EXISTS");

      // 8. Prova no banco: outbox própria HOLD, fila produtiva intocada,
      //    worker claima ZERO, auditoria registrada, zero PROCESSANDO.
      const contagens = await pool.query<{
        outbox_hold: string;
        outbox_aberta: string;
        eventos_campanha: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM outbox_campanha o
             JOIN lote_campanha lc ON lc.id = o.lote_campanha_id
            WHERE lc.campanha_id = $1 AND o.estado = 'HOLD') AS outbox_hold,
           (SELECT count(*)::text FROM outbox_campanha o
             JOIN lote_campanha lc ON lc.id = o.lote_campanha_id
            WHERE lc.campanha_id = $1
              AND o.estado IN ('PENDING','READY','ENFILEIRADO')) AS outbox_aberta,
           (SELECT count(*)::text FROM evento_auditoria
            WHERE agregado_tipo = 'CAMPANHA_PERSISTIDA' AND agregado_id = $1) AS eventos_campanha`,
        [corpoPersist.campanhaId],
      );
      const c = contagens.rows[0]!;
      expect(Number(c.outbox_hold)).toBe(3);
      expect(Number(c.outbox_aberta)).toBe(0);
      expect(Number(c.eventos_campanha)).toBe(2); // PERSISTIDA + LOTE_CRIADO

      // fila produtiva INTOCADA pela jornada inteira (delta antes/depois)
      const depoisFila = await contagemFila();
      expect(depoisFila).toEqual(antesFila);

      const repository = new PostgresOperationalRepository(pool);
      const claimed = await repository.claimOutbox("worker-teste-slice02", 10, new Date().toISOString());
      expect(claimed).toHaveLength(0);

      // 9. GET batch: estado sem segredos
      const loteGet = await despachar("GET", `/api/campaigns/batch?campanhaId=${corpoPersist.campanhaId}`, {
        headers: { cookie: operador.cookie },
      });
      expect(loteGet.status).toBe(200);
      expect(loteGet.corpo).not.toMatch(/session_hash|token_hash|set-cookie/i);
    } finally {
      await pool.close();
    }
  });

    it("isolamento por operador: terceiro EXECUTOR não lê nem materializa campanha/lote alheios (403/404, delta zero)", async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    const fingerprint = sha(`isolamento-${randomUUID()}`);
    try {
      const adminCookie = await bootstrapAdmin();
      const dono = await provisionOperator(adminCookie, ["PREPARADOR", "EXECUTOR"]);
      const outro = await provisionOperator(adminCookie, ["EXECUTOR"]);

      // Proprietário persiste a campanha (hash congelado no servidor).
      const persistida = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: dono.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: [],
        })),
      });
      expect(persistida.status).toBe(201);
      const alvo = JSON.parse(persistida.corpo) as { campanhaId: string; conteudoHash: string };

      // Delta escopado à campanha + fila produtiva (CI compartilhada): a prova
      // de não-mutação é antes/depois em cada tentativa indevida.
      const contagemIsolamento = async (): Promise<Record<string, string>> => {
        const resultado = await pool.query<{ tabela: string; total: string }>(
          `SELECT 'campanha_persistida' AS tabela, count(*)::text AS total FROM campanha_persistida WHERE id = $1
           UNION ALL SELECT 'campanha_decisao', count(*)::text FROM campanha_decisao WHERE campanha_id = $1
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
      const antes = await contagemIsolamento();

      // 1. hash CORRETO de campanha alheia → 403 ANTES da validação operacional
      const loteHashCorreto = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: outro.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: alvo.campanhaId,
          conteudoHash: alvo.conteudoHash,
        })),
      });
      expect(loteHashCorreto.status).toBe(403);
      expect(loteHashCorreto.corpo).toContain("CAMPAIGN_OPERATOR_FORBIDDEN");

      // 2. hash INCORRETO de campanha alheia → mesmo 403, sem revelar stale
      const loteHashErrado = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: outro.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: alvo.campanhaId,
          conteudoHash: "b".repeat(64),
        })),
      });
      expect(loteHashErrado.status).toBe(403);
      expect(loteHashErrado.corpo).toContain("CAMPAIGN_OPERATOR_FORBIDDEN");
      expect(loteHashErrado.corpo).not.toContain("CAMPAIGN_APPROVAL_STALE");

      // 3. leitura por terceiro: 404 sanitizado (sem revelar existência)
      const lidaPorTerceiro = await despachar(
        "GET",
        `/api/campaigns/persisted?hash=${encodeURIComponent(alvo.conteudoHash)}`,
        { headers: { cookie: outro.cookie } },
      );
      expect(lidaPorTerceiro.status).toBe(404);
      expect(lidaPorTerceiro.corpo).toContain("CAMPAIGN_PERSISTED_NOT_FOUND");

      const loteDeTerceiro = await despachar(
        "GET",
        `/api/campaigns/batch?campanhaId=${alvo.campanhaId}`,
        { headers: { cookie: outro.cookie } },
      );
      expect(loteDeTerceiro.status).toBe(404);
      expect(loteDeTerceiro.corpo).toContain("CAMPAIGN_BATCH_NOT_FOUND");

      // 4. persist idempotente de terceiro → 403 sem devolver campanhaId
      const persistTerceiro = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: outro.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: [],
        })),
      });
      expect(persistTerceiro.status).toBe(403);
      expect(persistTerceiro.corpo).toContain("CAMPAIGN_OPERATOR_FORBIDDEN");
      expect(persistTerceiro.corpo).not.toContain(alvo.campanhaId);

      // Delta ZERO em todas as tentativas indevidas.
      const depoisTentativas = await contagemIsolamento();
      expect(depoisTentativas).toEqual(antes);

      // Proprietário segue plenamente operante: recupera e materializa o lote.
      const recuperadaDono = await despachar(
        "GET",
        `/api/campaigns/persisted?hash=${encodeURIComponent(alvo.conteudoHash)}`,
        { headers: { cookie: dono.cookie } },
      );
      expect(recuperadaDono.status).toBe(200);

      const loteDono = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: dono.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: alvo.campanhaId,
          conteudoHash: alvo.conteudoHash,
        })),
      });
      expect(loteDono.status).toBe(201);
      expect((JSON.parse(loteDono.corpo) as { lote: { estado: string } }).lote.estado).toBe("HOLD");

      const loteGetDono = await despachar(
        "GET",
        `/api/campaigns/batch?campanhaId=${alvo.campanhaId}`,
        { headers: { cookie: dono.cookie } },
      );
      expect(loteGetDono.status).toBe(200);

      // 5. idempotência NÃO serve a terceiros: lote já existente → 403
      const loteTerceiroPos = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: outro.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: alvo.campanhaId,
          conteudoHash: alvo.conteudoHash,
        })),
      });
      expect(loteTerceiroPos.status).toBe(403);
      expect(loteTerceiroPos.corpo).toContain("CAMPAIGN_OPERATOR_FORBIDDEN");

      // Estado final escopado: HOLD ×3, 2 eventos, fila produtiva intocada.
      const final = await contagemIsolamento();
      expect(Number(final.campanha_persistida)).toBe(1);
      expect(Number(final.lote_campanha)).toBe(1);
      expect(Number(final.outbox_campanha)).toBe(3);
      expect(Number(final.evento_auditoria)).toBe(2);
      expect(final.outbox_email).toBe(antes.outbox_email);
      expect(final.comunicacao).toBe(antes.comunicacao);
      expect(final.lote_comunicacao).toBe(antes.lote_comunicacao);
    } finally {
      await pool.close();
    }
  });

it("operador suspenso é recusado na persistência (RBAC + estado)", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    try {
      const suspensao = await despachar("POST", "/api/operator/admin/suspend", {
        headers: { cookie: adminCookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ operatorId: preparador.operatorId, motivo: "TESTE_SUSPENSAO" })),
      });
      expect([200, 201]).toContain(suspensao.status);

      const resposta = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: "a".repeat(64),
          registros: REGISTROS,
          decisoes: [],
        })),
      });
      expect([401, 403]).toContain(resposta.status);
    } finally {
      await pool.close();
    }
  });
});

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
