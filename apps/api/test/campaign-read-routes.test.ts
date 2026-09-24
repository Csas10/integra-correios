import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  AvaliacaoInvalidaError,
  avaliarArquivoCampanha,
  avaliarBaseCampanha,
  camposObrigatoriosMapeamento,
  validarMapeamentoCampanha,
} from "../src/campaign-import.js";
import {
  baseSinteticaCampanha,
  carregarPoliticaCampanhaAtualizacao,
  hashAprovacaoCampanha,
} from "../src/campaigns.js";
import { despachar } from "../src/server.js";

// ---------------------------------------------------------------------------
// Ambiente: os testes HTTP sem banco exigem DATABASE_URL ausente (fail-closed
// → 503 determinístico). O valor ambiente é capturado AQUI, na carga do
// módulo, restaurado no bloco DB-gated e normalizado no afterAll do arquivo.
// ---------------------------------------------------------------------------
const DB_URL_AMBIENTE = process.env.DATABASE_URL;
const ORIGINAL_OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DB_URL_AMBIENTE;
});

afterEach(() => {
  if (ORIGINAL_OPERATOR_TOKEN === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = ORIGINAL_OPERATOR_TOKEN;
});

const COOKIE_SESSAO = `__Host-ic_campaign_operator_session=${"A".repeat(43)}`;
const ROTA_STATUS = "/api/campaigns/status";
const ROTA_SYNTHETIC = "/api/campaigns/synthetic-base";
const ROTA_ANALYZE = "/api/campaigns/analyze";
const ROTA_EVALUATE = "/api/campaigns/evaluate";
const ROTA_AUTHORIZE = "/api/campaigns/authorize";

const CABECALHOS_CANONICOS = ["MATRICULA", "NOME", "EMAIL"] as const;

const LINHAS_VALIDAS: string[][] = [
  ["1001", "Ana Silva", "ana@exemplo.com"],
  ["1002", "Bruna Souza", "bruna@exemplo.com"],
];

const REGISTROS_APROVACAO = [
  {
    profissional_id: "1001",
    nome: "Ana Silva",
    email_normalizado: "ana@exemplo.com",
    status_validacao: "APTO",
  },
  {
    profissional_id: "1002",
    nome: "Bruna Souza",
    email_normalizado: "bruna@exemplo.com",
    status_validacao: "APTO",
  },
];

/** Monta um .xlsx mínimo válido (folha única, cabeçalho + N linhas de texto). */
function xlsxMinimo(cabecalhos: string[], linhas: string[][]): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const folha = XLSX.utils.aoa_to_sheet([cabecalhos, ...linhas]);
  XLSX.utils.book_append_sheet(workbook, folha, "Base");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** Spread defensivo para não propagar `undefined` sob exactOptionalPropertyTypes. */
function opcoesDespacho(
  opcoes: { headers?: Record<string, string>; corpo?: Buffer },
): { headers?: Record<string, string>; corpo?: Buffer } {
  return {
    ...(opcoes.headers ? { headers: opcoes.headers } : {}),
    ...(opcoes.corpo ? { corpo: opcoes.corpo } : {}),
  };
}

function entradaAprovacao() {
  return { templateVersao: "pf-atualizacao-cadastral-2026-v1", registros: REGISTROS_APROVACAO };
}

// ---------------------------------------------------------------------------
// 1. Autenticação fail-closed (sem banco): 401 sem/cookie inválido,
//    503 com cookie de formato válido e identidade indisponível. Nenhum
//    fallback Bearer e nenhuma rota acessível sem identidade individual.
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — autenticação fail-closed", () => {
  for (const [metodo, rota] of [
    ["GET", ROTA_SYNTHETIC],
    ["POST", ROTA_ANALYZE],
    ["POST", ROTA_EVALUATE],
    ["POST", ROTA_AUTHORIZE],
  ] as const) {
    it(`${metodo} ${rota} sem sessão individual → 401 (Bearer técnico não é fallback)`, async () => {
      process.env.OPERATOR_TOKEN = "legacy-token-nao-usado";
      const resposta = await despachar(
        metodo,
        rota,
        opcoesDespacho({
          headers: { authorization: "Bearer legacy-token-nao-usado" },
          corpo: Buffer.from("{}"),
        }),
      );
      expect(resposta.status).toBe(401);
      expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
    });

    it(`${metodo} ${rota} com cookie de formato inválido → 401`, async () => {
      const resposta = await despachar(
        metodo,
        rota,
        opcoesDespacho({
          headers: { cookie: "__Host-ic_campaign_operator_session=curto" },
          corpo: Buffer.from("{}"),
        }),
      );
      expect(resposta.status).toBe(401);
    });

    it(`${metodo} ${rota} com sessão de formato válido e sem banco → 503 fail-closed`, async () => {
      const resposta = await despachar(
        metodo,
        rota,
        opcoesDespacho({
          headers: { cookie: COOKIE_SESSAO },
          corpo: Buffer.from("{}"),
        }),
      );
      expect(resposta.status).toBe(503);
      expect(resposta.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Capability gates — literais false na política e no contrato HTTP.
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — capability gates fechados", () => {
  it("política com ambiente produtivo-like mantém os três gates false", () => {
    const policy = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_ENABLED: "true",
      REAL_SEND_ENABLED: "true",
      DATABASE_URL: "postgresql://qualquer-banco/db",
    });
    expect(policy.canPersistImport).toBe(false);
    expect(policy.canCreateBatch).toBe(false);
    expect(policy.canExecute).toBe(false);
    expect(policy.phase).toBe("FOUNDATION");
    expect(policy.individualOperatorIdentityRequired).toBe(true);
  });

  it("nenhuma feature flag arma persistência, lote ou execução", () => {
    for (const env of [
      { PF_CAMPAIGN_ENABLED: "true" },
      { REAL_SEND_ENABLED: "true" },
      { PF_CAMPAIGN_ENABLED: "true", REAL_SEND_ENABLED: "true" },
    ]) {
      const policy = carregarPoliticaCampanhaAtualizacao(env);
      expect(policy.canPersistImport).toBe(false);
      expect(policy.canCreateBatch).toBe(false);
      expect(policy.canExecute).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Hash de aprovação — determinístico e sensível a qualquer alteração.
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — hashAprovacaoCampanha determinístico", () => {
  it("mesma entrada → mesmo hash SHA-256", () => {
    const a = hashAprovacaoCampanha(entradaAprovacao());
    const b = hashAprovacaoCampanha(entradaAprovacao());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("alterar template, conjunto, e-mail ou status → hash divergente", () => {
    const base = hashAprovacaoCampanha(entradaAprovacao());
    expect(
      hashAprovacaoCampanha({ ...entradaAprovacao(), templateVersao: "outra-versao" }),
    ).not.toBe(base);
    expect(
      hashAprovacaoCampanha({
        ...entradaAprovacao(),
        registros: [REGISTROS_APROVACAO[0]!],
      }),
    ).not.toBe(base);
    expect(
      hashAprovacaoCampanha({
        ...entradaAprovacao(),
        registros: [
          REGISTROS_APROVACAO[0]!,
          { ...REGISTROS_APROVACAO[1]!, email_normalizado: "bruna.outra@exemplo.com" },
        ],
      }),
    ).not.toBe(base);
    expect(
      hashAprovacaoCampanha({
        ...entradaAprovacao(),
        registros: [
          REGISTROS_APROVACAO[0]!,
          { ...REGISTROS_APROVACAO[1]!, status_validacao: "BLOQUEADO" },
        ],
      }),
    ).not.toBe(base);
  });

  it("hash é sensível até à ordem dos registros (congelamento fiel do conteúdo)", () => {
    const base = hashAprovacaoCampanha(entradaAprovacao());
    const invertida = hashAprovacaoCampanha({
      templateVersao: "pf-atualizacao-cadastral-2026-v1",
      registros: [...REGISTROS_APROVACAO].reverse(),
    });
    expect(invertida).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// 4. Mapeamento — validação server-side pura (contrato do x-mapping).
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — validarMapeamentoCampanha", () => {
  it("campos obrigatórios são profissional_id, nome e email_original", () => {
    expect(camposObrigatoriosMapeamento()).toEqual([
      "profissional_id",
      "nome",
      "email_original",
    ]);
  });

  it("mapeamento completo sem coluna duplicada é aceito", () => {
    expect(() =>
      validarMapeamentoCampanha({ profissional_id: 0, nome: 1, email_original: 2 }),
    ).not.toThrow();
  });

  it("coluna duplicada entre campos → COLUNA_DUPLICADA", () => {
    try {
      validarMapeamentoCampanha({ profissional_id: 0, nome: 0, email_original: 2 });
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      expect(error).toBeInstanceOf(AvaliacaoInvalidaError);
      expect((error as AvaliacaoInvalidaError).codigo).toBe("COLUNA_DUPLICADA");
    }
  });

  it("campo fora do contrato → CAMPO_DESCONHECIDO", () => {
    try {
      validarMapeamentoCampanha({ profissional_id: 0, nome: 1, email_original: 2, intruso: 3 });
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      expect((error as AvaliacaoInvalidaError).codigo).toBe("CAMPO_DESCONHECIDO");
    }
  });

  it("obrigatório ausente → MAPEAMENTO_INCOMPLETO", () => {
    try {
      validarMapeamentoCampanha({ nome: 1, email_original: 2 });
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      expect((error as AvaliacaoInvalidaError).codigo).toBe("MAPEAMENTO_INCOMPLETO");
    }
  });

  it("coluna não-inteira ou negativa → COLUNA_INVALIDA", () => {
    try {
      validarMapeamentoCampanha({ profissional_id: -1, nome: 1, email_original: 2 });
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      expect((error as AvaliacaoInvalidaError).codigo).toBe("COLUNA_INVALIDA");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Avaliação da base — recomputação server-side (unitários, sem HTTP).
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — avaliarArquivoCampanha / avaliarBaseCampanha", () => {
  it("analyze-puro devolve sha256, cabeçalhos e sugestão de mapeamento", () => {
    const analise = avaliarArquivoCampanha(
      "base.xlsx",
      xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS]),
    );
    expect(analise.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(analise.folhas_disponiveis).toEqual(["Base"]);
    expect(analise.cabecalhos).toEqual([...CABECALHOS_CANONICOS]);
    expect(analise.total_linhas).toBe(2);
    expect(analise.mapeamento_sugerido).toEqual({
      profissional_id: 0,
      nome: 1,
      nome_exibicao: -1,
      email_original: 2,
      email_normalizado: -1,
      status_validacao: -1,
      motivo_bloqueio: -1,
    });
  });

  it("com mapeamento confirmado, original é preservado e normalizado derivado no servidor", () => {
    const base = avaliarBaseCampanha(
      "base.xlsx",
      xlsxMinimo([...CABECALHOS_CANONICOS], [["1001", "  Ana  Silva  ", " ANA@Exemplo.COM "]]),
      { mapeamento: { profissional_id: 0, nome: 1, email_original: 2 } },
    );
    const registro = base.registros[0]!;
    expect(registro.email_original).toBe(" ANA@Exemplo.COM ");
    expect(registro.email_normalizado).toBe("ana@exemplo.com");
    expect(registro.status_validacao).toBe("APTO");
    expect(registro.normalizacoes_aplicadas).toEqual(
      expect.arrayContaining(["NOME_ESPACOS", "EMAIL_ESPACOS", "EMAIL_CASE"]),
    );
    expect(registro.inconsistencias).toContain("EMAIL_NORMALIZACAO");
  });

  it("email_normalizado informado divergente do derivado → EMAIL_NORMALIZADO_DIVERGENTE", () => {
    const base = avaliarBaseCampanha(
      "base.xlsx",
      xlsxMinimo(
        [...CABECALHOS_CANONICOS, "EMAIL_NORMALIZADO"],
        [["1001", "Ana Silva", "ana@exemplo.com", "outra@exemplo.com"]],
      ),
      { mapeamento: { profissional_id: 0, nome: 1, email_original: 2, email_normalizado: 3 } },
    );
    expect(base.registros[0]?.inconsistencias).toContain("EMAIL_NORMALIZADO_DIVERGENTE");
  });

  it("duplicidade de e-mail e de identificador vira inconsistência humana", () => {
    const base = avaliarBaseCampanha(
      "base.xlsx",
      xlsxMinimo([...CABECALHOS_CANONICOS], [
        ["1001", "Ana Um", "ana@exemplo.com"],
        ["1001", "Ana Dois", "bruna@exemplo.com"],
        ["1002", "Bruna", "ana@exemplo.com"],
      ] as string[][]),
      { mapeamento: { profissional_id: 0, nome: 1, email_original: 2 } },
    );
    expect(base.inconsistencias_pendentes).toBe(3);
    expect(base.duplicidades_email).toHaveLength(1);
    expect(base.bloqueados).toBe(3);
    expect(base.aptos).toBe(0);
  });

  it("arquivo não-XLSX → LeituraSeguraError (422 na rota)", () => {
    // SheetJS é tolerante a bytes não-ZIP (interpretam como CSV); a guarda
    // real é a extensão obrigatória .xlsx e a inspeção de conteúdo executável.
    expect(() =>
      avaliarArquivoCampanha("base.txt", new TextEncoder().encode("isto nao e um xlsx")),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. synthetic-base — conteúdo estritamente sintético (unitário da fonte).
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — baseSinteticaCampanha", () => {
  it("todos os registros são PF-SINTETICO com e-mail em domínio .test", () => {
    const registros = baseSinteticaCampanha();
    expect(registros.length).toBeGreaterThan(0);
    for (const registro of registros) {
      expect(registro.profissional_id.startsWith("PF-SINTETICO")).toBe(true);
      expect(registro.email_normalizado.endsWith(".test")).toBe(true);
    }
    expect(new Set(registros.map((r) => r.email_normalizado)).size).toBeLessThan(
      registros.length,
    ); // inclui caso de duplicidade proposital
  });
});

// ---------------------------------------------------------------------------
// 7. Prova estática de não-persistência: os módulos da camada de campanha
//    não contêm SQL de escrita, outbox, Gmail, pool nem executor.
// ---------------------------------------------------------------------------
describe("CAMPAIGN_READ_ROUTES — prova estática de zero-persistência", () => {
  it("campaigns.ts e campaign-import.ts não referenciam escrita/outbox/Gmail/DB/worker", async () => {
    const fontes = await Promise.all([
      fs.readFile(new URL("../src/campaigns.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/campaign-import.ts", import.meta.url), "utf8"),
    ]);
    for (const fonte of fontes) {
      expect(fonte).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/);
      expect(fonte).not.toMatch(/\boutbox\b/i);
      expect(fonte).not.toMatch(/\bgmail\b/i);
      expect(fonte).not.toMatch(/requireDb|NodePostgresPool|claimOutbox|executarLive|enqueueCommunicationBatch/);
    }
  });

  it("a política declara persistida-apenas-em-memória e fase FOUNDATION", () => {
    const policy = carregarPoliticaCampanhaAtualizacao({});
    expect(policy.phase).toBe("FOUNDATION");
    expect(policy.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Bloco DB-gated (CI / PostgreSQL 16): papéis reais por sessão individual,
//    contratos HTTP completos, 409 CAMPAIGN_APPROVAL_STALE, persistida:false
//    e prova de zero-escrita (contadores de outbox/auditoria inalterados).
//    Localmente é skipped — skip por ausência de DATABASE_URL NÃO é PASS.
// ---------------------------------------------------------------------------
const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

describeDb("CAMPAIGN_READ_ROUTES — papéis, contratos HTTP e zero-escrita (PostgreSQL)", () => {
  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

  function firstCookie(header: string | undefined): string {
    return header?.split("\n")[0]?.split(";")[0] ?? "";
  }

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

  beforeAll(() => {
    // O bloco DB-gated restaura o ambiente capturado (beforeAll do arquivo
    // removeu DATABASE_URL para os testes fail-closed sem banco).
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
  });

  it("matriz de papéis: PREPARADOR opera etapas 3–5, APROVADOR só autoriza, EXECUTOR nada aqui", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
    const aprovador = await provisionOperator(adminCookie, ["APROVADOR"]);
    const executor = await provisionOperator(adminCookie, ["EXECUTOR"]);

    // PREPARADOR: synthetic-base, analyze, evaluate OK; authorize bloqueado.
    const base = await despachar("GET", ROTA_SYNTHETIC, { headers: { cookie: preparador.cookie } });
    expect(base.status).toBe(200);
    const corpoBase = JSON.parse(base.corpo) as { registros: unknown[]; aviso: string };
    expect(corpoBase.registros.length).toBeGreaterThan(0);
    expect(corpoBase.aviso).toContain("NÃO representa destinatários reais");

    const analise = await despachar("POST", ROTA_ANALYZE, {
      headers: {
        cookie: preparador.cookie,
        "x-file-name": encodeURIComponent("base-campanha.xlsx"),
      },
      corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS])),
    });
    expect(analise.status).toBe(200);
    const corpoAnalise = JSON.parse(analise.corpo) as { sha256: string; total_linhas: number };
    expect(corpoAnalise.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(corpoAnalise.total_linhas).toBe(2);

    const avaliacao = await despachar("POST", ROTA_EVALUATE, {
      headers: {
        cookie: preparador.cookie,
        "x-file-name": encodeURIComponent("base-campanha.xlsx"),
        "x-mapping": JSON.stringify({ profissional_id: 0, nome: 1, email_original: 2 }),
      },
      corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS])),
    });
    expect(avaliacao.status).toBe(200);
    const corpoAvaliacao = JSON.parse(avaliacao.corpo) as { total_registros: number; aptos: number };
    expect(corpoAvaliacao.total_registros).toBe(2);
    expect(corpoAvaliacao.aptos).toBe(2);

    const autorizacaoNegada = await despachar("POST", ROTA_AUTHORIZE, {
      headers: { cookie: preparador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(entradaAprovacao())),
    });
    expect(autorizacaoNegada.status).toBe(403);
    expect(autorizacaoNegada.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");

    // APROVADOR: autoriza com hash; synthetic-base/analyze/evaluate bloqueados.
    const hash = hashAprovacaoCampanha(entradaAprovacao());
    const aprovacao = await despachar("POST", ROTA_AUTHORIZE, {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ ...entradaAprovacao(), conteudoHash: hash })),
    });
    expect(aprovacao.status).toBe(200);
    const corpoAprovacao = JSON.parse(aprovacao.corpo) as {
      status: string;
      conteudoHash: string;
      totalItens: number;
      persistida: boolean;
      aprovadaPor: string;
    };
    expect(corpoAprovacao.status).toBe("CAMPAIGN_APPROVAL_FROZEN");
    expect(corpoAprovacao.conteudoHash).toBe(hash);
    expect(corpoAprovacao.totalItens).toBe(REGISTROS_APROVACAO.length);
    expect(corpoAprovacao.persistida).toBe(false);
    expect(corpoAprovacao.aprovadaPor).toBe(aprovador.operatorId);

    expect((await despachar("GET", ROTA_SYNTHETIC, { headers: { cookie: aprovador.cookie } })).status).toBe(403);
    expect((await despachar("POST", ROTA_ANALYZE, {
      headers: { cookie: aprovador.cookie, "x-file-name": "base.xlsx" },
      corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [])),
    })).status).toBe(403);

    // EXECUTOR: nada nesta fase (canExecute=false).
    expect((await despachar("GET", ROTA_SYNTHETIC, { headers: { cookie: executor.cookie } })).status).toBe(403);
    expect((await despachar("POST", ROTA_AUTHORIZE, {
      headers: { cookie: executor.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(entradaAprovacao())),
    })).status).toBe(403);
  });

  it("hash divergente submetido → 409 CAMPAIGN_APPROVAL_STALE (aprovação nunca silencia divergência)", async () => {
    const adminCookie = await bootstrapAdmin();
    const aprovador = await provisionOperator(adminCookie, ["APROVADOR"]);
    const resposta = await despachar("POST", ROTA_AUTHORIZE, {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        ...entradaAprovacao(),
        conteudoHash: "0".repeat(64),
      })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_APPROVAL_STALE");
    expect(resposta.corpo).not.toContain(hashAprovacaoCampanha(entradaAprovacao()));
  });

  it("entradas inválidas com sessão PREPARADOR → 400/422 antes de qualquer processamento", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
    const cookie = { cookie: preparador.cookie };
    const xlsx = () => Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], []));

    const nomeMalformado = await despachar("POST", ROTA_ANALYZE, {
      headers: { ...cookie, "x-file-name": "%zz" }, corpo: xlsx(),
    });
    expect(nomeMalformado.status).toBe(400);
    expect(nomeMalformado.corpo).toContain("FILE_NAME_MALFORMED");

    const nomeExcessivo = await despachar("POST", ROTA_ANALYZE, {
      headers: { ...cookie, "x-file-name": encodeURIComponent("a".repeat(2100)) }, corpo: xlsx(),
    });
    expect(nomeExcessivo.status).toBe(400);
    expect(nomeExcessivo.corpo).toContain("FILE_NAME_TOO_LARGE");

    const naoXlsx = await despachar("POST", ROTA_ANALYZE, {
      headers: { ...cookie, "x-file-name": "base.xlsx" },
      corpo: Buffer.from("isto nao e um xlsx"),
    });
    expect(naoXlsx.status).toBe(422);
    expect(naoXlsx.corpo).toContain("CAMPAIGN_FILE_INVALID");

    for (const [mapping, codigo] of [
      ["nao-json", "MAPPING_MALFORMED"],
      ["[1,2]", "MAPPING_INVALID_SCHEMA"],
      [JSON.stringify({ nome: -1 }), "MAPPING_INVALID_SCHEMA"],
      [JSON.stringify({ nome: 1024 }), "MAPPING_INVALID_SCHEMA"],
      [JSON.stringify({ intruso: 0 }), "MAPPING_INVALID_SCHEMA"],
    ] as const) {
      const resposta = await despachar("POST", ROTA_EVALUATE, {
        headers: { ...cookie, "x-file-name": "base.xlsx", "x-mapping": mapping },
        corpo: xlsx(),
      });
      expect(resposta.status).toBe(400);
      expect(resposta.corpo).toContain(codigo);
    }

    const mapeamentoIncompleto = await despachar("POST", ROTA_EVALUATE, {
      headers: { ...cookie, "x-file-name": "base.xlsx", "x-mapping": JSON.stringify({ nome: 1 }) },
      corpo: xlsx(),
    });
    expect(mapeamentoIncompleto.status).toBe(400);
    expect(mapeamentoIncompleto.corpo).toContain("MAPEAMENTO_INCOMPLETO");

    const semMapping = await despachar("POST", ROTA_EVALUATE, {
      headers: { ...cookie, "x-file-name": "base.xlsx" },
      corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS])),
    });
    expect(semMapping.status).toBe(200);
    expect((JSON.parse(semMapping.corpo) as { total_registros: number }).total_registros).toBe(2);

    for (const corpoAutorizacao of [
      JSON.stringify({ registros: REGISTROS_APROVACAO }),
      JSON.stringify({ templateVersao: "v1", registros: [] }),
      JSON.stringify({
        templateVersao: "v1",
        registros: [{ profissional_id: "1", nome: "A", email_normalizado: "a@exemplo.com" }],
      }),
      JSON.stringify({
        templateVersao: "v".repeat(81),
        registros: REGISTROS_APROVACAO,
      }),
      "{invalido",
    ]) {
      const resposta = await despachar("POST", ROTA_AUTHORIZE, {
        headers: { ...cookie, "content-type": "application/json" },
        corpo: Buffer.from(corpoAutorizacao),
      });
      expect([400, 422]).toContain(resposta.status);
    }
  });

  it("zero-escrita em PostgreSQL: contadores de outbox/comunicação/auditoria idênticos antes e depois das 4 rotas", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
    const aprovador = await provisionOperator(adminCookie, ["APROVADOR"]);
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    try {
      const contagem = async (): Promise<Record<string, string>> => {
        const resultado = await pool.query<{ tabela: string; total: string }>(
          `SELECT 'outbox_email' AS tabela, count(*)::text AS total FROM outbox_email
           UNION ALL SELECT 'comunicacao', count(*)::text FROM comunicacao
           UNION ALL SELECT 'lote_comunicacao', count(*)::text FROM lote_comunicacao
           UNION ALL SELECT 'evento_auditoria', count(*)::text FROM evento_auditoria`,
        );
        return Object.fromEntries(resultado.rows.map((r) => [r.tabela, r.total]));
      };
      const antes = await contagem();

      await despachar("GET", ROTA_SYNTHETIC, { headers: { cookie: preparador.cookie } });
      await despachar("POST", ROTA_ANALYZE, {
        headers: { cookie: preparador.cookie, "x-file-name": "base.xlsx" },
        corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS])),
      });
      await despachar("POST", ROTA_EVALUATE, {
        headers: {
          cookie: preparador.cookie,
          "x-file-name": "base.xlsx",
          "x-mapping": JSON.stringify({ profissional_id: 0, nome: 1, email_original: 2 }),
        },
        corpo: Buffer.from(xlsxMinimo([...CABECALHOS_CANONICOS], [...LINHAS_VALIDAS])),
      });
      await despachar("POST", ROTA_AUTHORIZE, {
        headers: { cookie: aprovador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify(entradaAprovacao())),
      });

      const depois = await contagem();
      expect(depois).toEqual(antes);
    } finally {
      await pool.close();
    }
  });

  it("GET /api/campaigns/status com sessão real devolve os três gates false", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionOperator(adminCookie, ["PREPARADOR"]);
    const resposta = await despachar("GET", ROTA_STATUS, { headers: { cookie: preparador.cookie } });
    expect(resposta.status).toBe(200);
    const corpo = JSON.parse(resposta.corpo) as {
      canPersistImport: boolean;
      canCreateBatch: boolean;
      canExecute: boolean;
    };
    expect(corpo.canPersistImport).toBe(false);
    expect(corpo.canCreateBatch).toBe(false);
    expect(corpo.canExecute).toBe(false);
  });
});
