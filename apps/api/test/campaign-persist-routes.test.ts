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
    try {
      const adminCookie = await bootstrapAdmin();
      const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
      const executor = await provisionOperator(adminCookie, ["EXECUTOR"]);

      // RBAC de gate: com flags fechadas, persist recusa mesmo autenticado
      process.env.PF_CAMPAIGN_PERSIST_ENABLED = "false";
      const negado = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          fingerprintArquivo: fingerprint,
          registros: REGISTROS,
          decisoes: [],
        })),
      });
      expect(negado.status).toBe(403);
      expect(negado.corpo).toContain("CAMPAIGN_PERSIST_DISABLED");
      process.env.PF_CAMPAIGN_PERSIST_ENABLED = "true";

      // 1. persist (PREPARADOR): 201 CRIADA
      const persistida = await despachar("POST", "/api/campaigns/persist", {
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
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
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
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
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
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
        { headers: { cookie: preparador.cookie } },
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
        headers: { cookie: preparador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({
          campanhaId: corpoPersist.campanhaId,
          conteudoHash: corpoPersist.conteudoHash,
        })),
      });
      expect(loteSemPapel.status).toBe(403);
      expect(loteSemPapel.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");

      // 6. batch por EXECUTOR → 201, lote HOLD + outbox NÃO capturável
      const loteCriado = await despachar("POST", "/api/campaigns/batch", {
        headers: { cookie: executor.cookie, "content-type": "application/json" },
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
        headers: { cookie: executor.cookie, "content-type": "application/json" },
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
        outbox_email_total: string;
        comunicacao_total: string;
        eventos_campanha: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM outbox_campanha WHERE estado = 'HOLD') AS outbox_hold,
           (SELECT count(*)::text FROM outbox_campanha WHERE estado IN ('PENDING','READY','ENFILEIRADO')) AS outbox_aberta,
           (SELECT count(*)::text FROM outbox_email) AS outbox_email_total,
           (SELECT count(*)::text FROM comunicacao) AS comunicacao_total,
           (SELECT count(*)::text FROM evento_auditoria WHERE agregado_tipo = 'CAMPANHA_PERSISTIDA') AS eventos_campanha`,
      );
      const c = contagens.rows[0]!;
      expect(Number(c.outbox_hold)).toBeGreaterThanOrEqual(3);
      expect(Number(c.outbox_aberta)).toBe(0);
      // fila produtiva INTOCADA (ponte de execução pertence a outro gate)
      expect(Number(c.outbox_email_total)).toBe(0);
      expect(Number(c.comunicacao_total)).toBe(0);
      expect(Number(c.eventos_campanha)).toBeGreaterThanOrEqual(2);

      const repository = new PostgresOperationalRepository(pool);
      const claimed = await repository.claimOutbox("worker-teste-slice02", 10, new Date().toISOString());
      expect(claimed).toHaveLength(0);

      // 9. GET batch: estado sem segredos
      const loteGet = await despachar("GET", `/api/campaigns/batch?campanhaId=${corpoPersist.campanhaId}`, {
        headers: { cookie: executor.cookie },
      });
      expect(loteGet.status).toBe(200);
      expect(loteGet.corpo).not.toMatch(/session_hash|token_hash|set-cookie/i);
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
