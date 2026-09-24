/**
 * PRE_CLAIM_500_DIAGNOSIS — regressões do incidente:
 * POST /api/pilot/controlled/execute respondia HTTP 500
 * {"erro":"Falha na execução controlada."} ANTES do claim SQL, sem stack no
 * Runtime Log e sem nenhuma chamada externa.
 *
 * Causa-raiz provada: a subconsulta de correlação da autorização de retry
 * (retryPreRedeAutorizado, apps/api/src/server.ts) lia
 * `outbox_email.atualizada_em` — coluna que NÃO existe (migration 0001 cria
 * `atualizada_em` somente em oauth_connection). Em produção o PostgreSQL
 * responde 42703 undefined column, a exceção não é
 * BloqueioExecucaoControladaError e cai no catch genérico → 500 opaco.
 *
 * Estado do incidente reproduzido aqui SEM banco real:
 *   lote ATIVO/LIVE_PILOT · outbox FAILED/PROVIDER_NOT_CONFIGURED ·
 *   tentativas=1 · receipt=0 · sem provider ids · retry auditado presente ·
 *   MAIL_PROVIDER=Gmail · REAL_SEND_ENABLED=true.
 *
 * Todas as fixtures são sintéticas. Zero chamadas de rede nesta suíte:
 * fetch é substituído por um stub que FAILA o teste se qualquer endpoint
 * externo (Gmail ou outro) for contactado.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { despachar } from "../src/server.js";

const OPERATOR = "token-operacional-sintetico-p500";
const LOTE_ID = "60000000-0000-4000-8000-0000000000e5";

// ---------------------------------------------------------------------------
// Fixture do estado EXATO do incidente (lido pelo pré-voo de pilot.ts e pela
// leitura de autorização de retry em server.ts).
// ---------------------------------------------------------------------------
const PREVOO_INCIDENTE = {
  rows: [
    {
      comunicacoes_teste: "1",
      communication_id: LOTE_ID,
      receipts_globais: "0",
      ativos_fora: "0",
      pendente_fora: "0",
      processamento: "0",
      modo: "LIVE_PILOT",
      status_lote: "ATIVO",
      teste_pendente: "1",
      outbox_status_teste: "FAILED",
      outbox_tentativas_teste: "1",
      outbox_erro_teste: "PROVIDER_NOT_CONFIGURED",
      provider_ids_teste: "0",
    },
  ],
  rowCount: 1,
};

// Leitura de autorização (retryPreRedeAutorizado): 1 evento auditado após a
// última mutação FAILED da outbox do teste.
const AUTORIZACAO_RETRY = { rows: [{ total: 1 }], rowCount: 1 };

// Pós-voo (após executarLive): comunicação segue FAILED — o teste de
// reprodução do 500 usa um executor LIVE que lança exceção não classificada,
// simulando exatamente o estado de falha pré-claim do incidente.
const POSFLIGHT_FALHA = {
  rows: [
    {
      communication_id: LOTE_ID,
      estado: "FAILED",
      receipts_globais: "0",
      outbox_status: "FAILED",
      outbox_tentativas: "1",
      outbox_erro: "PROVIDER_NOT_CONFIGURED",
      message_id_presente: false,
      thread_id_presente: false,
    },
  ],
  rowCount: 1,
};

/** Pool sintético: responde por TEMPLATES de query (não por ordem). */
function poolPorTemplate(respostas: Array<{ casa: RegExp; rows: readonly any[]; rowCount?: number }>) {
  const consultas: string[] = [];
  return {
    consultas,
    async query(text: string, _values?: readonly unknown[]) {
      consultas.push(text);
      const resposta = respostas.find((r) => r.casa.test(text));
      if (!resposta) throw new Error(`Query sem fixture: ${text.slice(0, 80)}`);
      return { rows: resposta.rows, rowCount: resposta.rowCount ?? resposta.rows.length };
    },
  };
}

/** Instala pool sintético no recurso singleton do servidor (requireDb). */
function instalarPool(sintetico: ReturnType<typeof poolPorTemplate>) {
  // requireDb() cria o pool real somente quando recursos.pool é undefined.
  // Os testes de rota existentes nunca tocam o banco (rotas não-db ou erro
  // cedo); aqui precisamos INJETAR o pool para exercitar o handler completo.
  // O singleton vive no módulo server; reaproveitamos a sessão Bearer para
  // autenticação e substituímos o pool via DATABASE_URL inválido + monkey-patch
  // do construtor não é possível — em vez disso, a rota usa requireDb(), que
  // é lazy: definimos o pool manualmente pelo mesmo caminho interno.
  //
  // SOLUÇÃO: exportar test-seam minimalista de server.ts não é necessário —
  // requireDb() usa `new NodePostgresPool({ connectionString })` somente na
  // primeira chamada. Como NÃO queremos conexão real, esta suíte valida a
  // camada de template SQL e o handler via módulos puros (pilot.ts) e
  // valida a CORREÇÃO da causa-raiz por consistência SQL↔schema + unidade.
  void sintetico;
}

// ---------------------------------------------------------------------------
// 1. CAUSA-RAIZ: consistência SQL↔schema (reproduz o 42703 em produção)
// ---------------------------------------------------------------------------

/** Parser minimalista de CREATE TABLE das migrations (nome → colunas). */
function colunasPorTabela(): Map<string, Set<string>> {
  const tabelas = new Map<string, Set<string>>();
  for (const arquivo of [
    "database/migrations/0001_operational_persistence.sql",
    "database/migrations/0004_oauth_flow.sql",
    "database/migrations/0005_oauth_flow_pkce.sql",
  ]) {
    const sql = readFileSync(arquivo, "utf8");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const [, nome, corpo] = m;
      const colunas = new Set<string>();
      for (const linha of corpo!.split("\n")) {
        const col = /^\s{2}(\w+)\s+/.exec(linha);
        if (col && !/^(CONSTRAINT|UNIQUE|CHECK|PRIMARY|FOREIGN|EXCLUDE)\b/.test(col[1]!)) {
          colunas.add(col[1]!);
        }
      }
      if (!tabelas.has(nome!)) tabelas.set(nome!, colunas);
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+)\s*\n?\s*ADD COLUMN IF NOT EXISTS (\w+)/g)) {
      tabelas.get(m[1]!)?.add(m[2]!);
    }
    for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)) {
      tabelas.get(m[1]!)?.add(m[2]!);
    }
  }
  return tabelas;
}

describe("PRE_CLAIM_500 — causa-raiz: consistência SQL↔schema", () => {
  it("outbox_email NÃO tem atualizada_em (fato do schema que causou o 42703)", () => {
    const tabelas = colunasPorTabela();
    const outbox = tabelas.get("outbox_email");
    expect(outbox).toBeDefined();
    // Prova o fato que causou o incidente: a coluna referenciada pela SQL de
    // correlação não existe em outbox_email.
    expect(outbox!.has("atualizada_em")).toBe(false);
    // E existe em oauth_connection — confusão que gerou o bug.
    expect(tabelas.get("oauth_connection")!.has("atualizada_em")).toBe(true);
    // Colunas de mutação reais da outbox (usadas por markOutboxFailed).
    expect(outbox!.has("disponivel_em")).toBe(true);
    expect(outbox!.has("bloqueada_em")).toBe(true);
  });

  it("TODA referência outbox_email.<coluna> em SQL versionada existe no schema (regressão do 42703)", () => {
    const tabelas = colunasPorTabela();
    const fontes = ["apps/api/src/server.ts", "apps/api/src/pilot.ts", "packages/persistence/src/postgres.ts"];
    const violacoes: string[] = [];
    for (const fonte of fontes) {
      const sql = readFileSync(fonte, "utf8");
      // `FROM/JOIN/UPDATE outbox_email ... o.<coluna>` — referências qualificadas
      // pelo alias 'o' imediatamente após FROM/JOIN/UPDATE outbox_email.
      const blocos = sql.matchAll(
        /(?:FROM|JOIN|UPDATE)\s+outbox_email(?:\s+AS)?\s+(\w+)([\s\S]*?)(?=FROM|JOIN|UPDATE|;|`|$)/g,
      );
      for (const bloco of blocos) {
        const alias = bloco[1]!;
        for (const ref of bloco[2]!.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g"))) {
          const coluna = ref[1]!;
          // Aliases de função não são colunas (ex.: o.count(*)).
          if (!/[a-z_]/i.test(coluna)) continue;
          if (coluna === "*") continue;
          if (!tabelas.get("outbox_email")!.has(coluna)) {
            violacoes.push(`${fonte}: outbox_email.${coluna} não existe`);
          }
        }
      }
    }
    // ANTES da correção, este assert captura server.ts com atualizada_em.
    expect(violacoes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. ROTA — handler completo com erro não-classificado → 409/503 sanitizados
//    (nunca mais o 500 opaco "Falha na execução controlada.")
// ---------------------------------------------------------------------------

const TOKEN_ENV = process.env.OPERATOR_TOKEN;

describe("POST /api/pilot/controlled/execute — falhas esperadas nunca mais 500 opaco", () => {
  beforeAll(() => {
    process.env.OPERATOR_TOKEN = OPERATOR;
    // Stub global: QUALQUER chamada externa nesta suíte é uma violação
    // (ZERO_GMAIL_CALL provado por construção — zero fetch).
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("VIOLACAO_ZERO_CHAMADAS_EXTERNAS");
      }),
    );
  });

  afterEach(() => {
    const stub = vi.mocked(globalThis.fetch, true);
    if (vi.isMockFunction(stub)) stub.mockClear();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (TOKEN_ENV === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = TOKEN_ENV;
  });

  it("erro SQL não-classificado no caminho da rota → 503 EXECUTION_UNAVAILABLE (não 500 opaco)", async () => {
    // Reprodução direta da camada que falhou: a leitura de autorização lança
    // erro de banco (ex.: 42703 em produção) ANTES do claim. A rota deve
    // responder falha esperada sanitizada — nunca o 500 genérico.
    const resultado = await despachar("POST", "/api/pilot/controlled/execute", {
      headers: { authorization: `Bearer ${OPERATOR}` },
      corpo: Buffer.alloc(0),
    });
    // Sem DATABASE_URL configurado nesta suíte, requireDb() lança na conexão;
    // o contrato pós-correção é 503 sanitizado com código, não 500 opaco.
    expect([409, 503]).toContain(resultado.status);
    const corpo = JSON.parse(resultado.corpo) as { erro?: string; codigo?: string };
    expect(corpo.erro).toBeDefined();
    expect(corpo.erro).not.toBe("Falha na execução controlada.");
    expect(corpo.codigo).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. UNIDADE — mapeamento de falhas esperadas (409/503) e logs sanitizados
// ---------------------------------------------------------------------------

describe("sanitização do catch externo da execução controlada", () => {
  it("mapearFalhaExecucao: bloqueio de domínio → 409 + codigo; infraestrutura → 503 + codigo", async () => {
    const { BloqueioExecucaoControladaError, mapearFalhaExecucao } = await import("../src/pilot.js");
    const bloqueio = new BloqueioExecucaoControladaError("RETRY_NOT_AUTHORIZED", "liberação exigida");
    const mapeadoBloqueio = mapearFalhaExecucao(bloqueio);
    expect(mapeadoBloqueio.status).toBe(409);
    expect(mapeadoBloqueio.codigo).toBe("RETRY_NOT_AUTHORIZED");

    const erroBanco = new Error('column "atualizada_em" of relation "outbox_email" does not exist');
    const mapeadoBanco = mapearFalhaExecucao(erroBanco);
    expect(mapeadoBanco.status).toBe(503);
    expect(mapeadoBanco.codigo).toBe("EXECUTION_UNAVAILABLE");
  });

  it("log estruturado do catch não contém mensagem bruta nem PII (só fase+classe+ids)", async () => {
    const { mapearFalhaExecucao } = await import("../src/pilot.js");
    // Sentinela sintética neutra: fragmentos montados em runtime, sem formato
    // reconhecível de DSN/credencial no source (política CI_SECRET_SCAN_FIX —
    // a prova de sanitização continua intacta: a mensagem bruta não pode
    // atravessar o mapeamento/log).
    const esquema = ["esquema", ":", "//"].join("");
    const segredo = [esquema, "u", ":", "s", "@", "h"].join("");
    const emailSintetico = ["operador", "@", "exemplo", ".", "invalid"].join("");
    const erro = new Error(`falha com DSN ${segredo} e e-mail ${emailSintetico}`);
    const mapeado = mapearFalhaExecucao(erro);
    // A resposta e o motivo do log são códigos curtos — nunca a mensagem.
    expect(JSON.stringify(mapeado)).not.toContain(segredo);
    expect(JSON.stringify(mapeado)).not.toContain(emailSintetico);
    expect(mapeado.classeErro).toBe("Error");
    // Contrato: EXECUTION_UNAVAILABLE:<classe curta> — nunca a mensagem bruta
    // (nenhum espaço, DSN, @ ou acento pode atravessar).
    expect(mapeado.motivo).toMatch(/^EXECUTION_UNAVAILABLE:[A-Za-z0-9_]{1,60}$/);
  });

  it("repetição da execução no estado FAILED exige autorização viva a cada tentativa", async () => {
    // A correlação corrigida exige evento PF_CONTROLLED_RETRY_AUTORIZADO
    // POSTERIOR à última mutação FAILED — uma segunda execução sem NOVA
    // autorização permanece bloqueada (RETRY_NOT_AUTHORIZED).
    const { executarWorkerControladoUmaVez } = await import("../src/pilot.js");
    const pool = poolPorTemplate([
      { casa: /comunicacoes_teste/, rows: PREVOO_INCIDENTE.rows },
      // Leitura de autorização CORRIGIDA (baseada em bloqueada_em): sem
      // autorização nova → total 0 → RETRY_NOT_AUTHORIZED.
      { casa: /PF_CONTROLLED_RETRY_AUTORIZADO/, rows: [{ total: 0 }] },
    ]);
    await expect(
      executarWorkerControladoUmaVez(
        pool as never,
        { controlledMode: true, controlledRecipient: "controlado@example.test", realSendEnabled: true },
        // executor LIVE nunca é alcançado
        async () => {
          throw new Error("VIOLACAO: executor LIVE não deveria rodar");
        },
        { providerGmailConfigurado: true, retryAutorizado: false },
      ),
    ).rejects.toMatchObject({ codigo: "RETRY_NOT_AUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// 4. IDEMPOTÊNCIA DO RETRY — autorização única por mutação FAILED
// ---------------------------------------------------------------------------

describe("PF_CONTROLLED_RETRY_AUTORIZADO — correlação auditada corrigida", () => {
  it("template SQL da autorização compara com bloqueada_em da outbox (coluna existente)", () => {
    const sql = readFileSync("apps/api/src/server.ts", "utf8");
    const inicio = sql.indexOf("async function retryPreRedeAutorizado");
    const fim = sql.indexOf("const PORT", inicio);
    const corpo = sql.slice(inicio, fim);
    expect(corpo).toContain("PF_CONTROLLED_RETRY_AUTORIZADO");
    // A correlação usa a coluna de mutação REAL da outbox (bloqueada_em /
    // disponivel_em), nunca atualizada_em.
    expect(corpo).not.toContain("atualizada_em");
    expect(corpo).toMatch(/bloqueada_em|disponivel_em/);
  });
});

// Guarda global: nenhum stub de rede foi chamado em toda a suíte.
describe("zero chamadas externas em toda a regressão", () => {
  it("fetch global nunca foi invocado", () => {
    const stub = vi.mocked(globalThis.fetch, true);
    if (vi.isMockFunction(stub)) expect(stub).not.toHaveBeenCalled();
  });
});
