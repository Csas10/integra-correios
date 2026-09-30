/**
 * GF-3 CORRECTIVE-02 — provas de rotas para F1/F2/F3/F7 (STRICT ZERO SEND).
 *
 *   · F1 AUTH_PROPRIA_ROUTE_KEYS_MATCH: o mapa ROTAS_AUTH_PROPRIA contém
 *     APENAS pares reais `METODO caminho` de rotas registradas (a fantasma
 *     `GET /api/campaigns/templates` foi removida; chaves do catálogo e das
 *     prévias incluídas) e cobre as rotas de sessão individual da campanha.
 *   · F2 APPROVER_TEMPLATE_CATALOG: o catálogo é legível por PREPARADOR e
 *     APROVADOR (e REVISOR, papel de revisão de conteúdo existente em
 *     PF_CAMPAIGN_ROLE_ACTIONS); EXECUTOR e ADMIN_TECNICO permanecem 403.
 *   · F3 AUTHORIZE_PERSIST_CANONICAL_EQUIVALENCE: authorize/persist/prévia
 *     compartilham a ÚNICA autoridade validarSubmissaoAprovacao; inputs
 *     logicamente equivalentes produzem o MESMO hash; o hash no authorize é
 *     calculado sobre os registros NORMALIZADOS (nunca o bruto).
 *   · F7 PRE_APPROVAL_PREVIEW_SERVER_RENDERED: POST template-preview revalida
 *     com a mesma autoridade, bounds-check do índice e responde apenas com
 *     metadados do registry + mensagem renderizada (sem persistência).
 *
 * Bloco DB-gated (CI/PostgreSQL 16): matriz de papéis com sessões
 * individuais REAIS (login individual + cookie __Host-) — o mesmo padrão de
 * campaign-read-routes.test.ts. Localmente é skipped — skip por ausência de
 * DATABASE_URL NÃO é PASS (POSTGRESQL_LOCAL=NOT_RUN).
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { despachar as despacharSemBanco } from "../src/server.js";
import {
  CAMPANHA_APROVACAO_V2,
  contentHashDoTemplateSelecionado,
  hashAprovacaoCampanha,
  normalizarExibicaoRegistroCampanha,
} from "../src/campaigns.js";

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
const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function firstCookie(header: string | undefined): string {
  return header?.split("\n")[0]?.split(";")[0] ?? "";
}

const FONTE_SERVER = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const TEMPLATE_V2 = "pf-expedicao-carteira-2026-v2";

/** Entrada de aprovação sintética (100% .test, zero PII real). */
function entradaAprovacao() {
  return {
    templateVersao: TEMPLATE_V2,
    registros: [
      {
        profissional_id: "PF-C2-0001",
        nome: "Ana Sintetica",
        email_normalizado: "ana.c2@exemplo.test",
        status_validacao: "APTO",
        exibicao: {
          telefone: "(00) 00000-0001",
          cep: "00000-001",
          logradouro: "Rua da Previa",
          numero: "101",
          bairro: "Bairro Sintetico",
          cidade: "Salvador",
          uf: "BA",
        },
      },
      {
        profissional_id: "PF-C2-0002",
        nome: "Bruno Sintetico",
        email_normalizado: "bruno.c2@exemplo.test",
        status_validacao: "APTO",
        exibicao: { cidade: "Salvador", uf: "BA" },
      },
    ],
  };
}

/** Hash V2 sobre os registros NORMALIZADOS pela autoridade de produção. */
function hashAutoridade(registros: readonly unknown[], templateVersao = TEMPLATE_V2): string {
  const normalizados = (
    registros as readonly {
      profissional_id: string;
      nome: string;
      email_normalizado: string;
      status_validacao: string;
      source_record_key?: string;
      exibicao?: Record<string, string>;
    }[]
  ).map((registro) => {
    const exibicao = normalizarExibicaoRegistroCampanha(registro.exibicao);
    return {
      profissional_id: registro.profissional_id,
      nome: registro.nome,
      email_normalizado: registro.email_normalizado,
      status_validacao: registro.status_validacao,
      ...(registro.source_record_key === undefined ? {} : { source_record_key: registro.source_record_key }),
      ...(exibicao === undefined ? {} : { exibicao }),
    };
  });
  return hashAprovacaoCampanha({
    contrato: CAMPANHA_APROVACAO_V2,
    templateVersao,
    templateContentHash: contentHashDoTemplateSelecionado(templateVersao),
    registros: normalizados,
  });
}

// ---------------------------------------------------------------------------
// F1 — AUTH_PROPRIA_ROUTE_KEYS_MATCH (prova estrutural, sem banco)
// ---------------------------------------------------------------------------
describe("GF3 C2 F1 — AUTH_PROPRIA_ROUTE_KEYS_MATCH", () => {
  /** Extrai pares `metodo caminhoExato` de TODAS as rotas registradas. */
  function rotasRegistradas(): Set<string> {
    const chaves = new Set<string>();
    const padrao = /metodo:\s*"(GET|POST|PUT|DELETE|PATCH)",\s*caminhoExato:\s*"([^"]+)"/g;
    for (const [, metodo, caminho] of FONTE_SERVER.matchAll(padrao)) {
      chaves.add(`${metodo} ${caminho}`);
    }
    return chaves;
  }

  function mapaAuthPropria(): string[] {
    const inicio = FONTE_SERVER.indexOf("const ROTAS_AUTH_PROPRIA = new Set([");
    const fim = FONTE_SERVER.indexOf("]);", inicio);
    const bloco = FONTE_SERVER.slice(inicio, fim);
    return [...bloco.matchAll(/"(GET|POST|PUT|DELETE|PATCH) ([^"]+)"/g)].map(
      ([, metodo, caminho]) => `${metodo} ${caminho}`,
    );
  }

  it("cada chave do mapa é um par real `METODO caminho` de rota registrada (sem fantasmas)", () => {
    const registradas = rotasRegistradas();
    expect(registradas.size).toBeGreaterThan(40);
    const fantasma = mapaAuthPropria().filter((chave) => !registradas.has(chave));
    expect(fantasma).toEqual([]);
    // A fantasma histórica NÃO existe mais no mapa (nem como rota):
    expect(mapaAuthPropria()).not.toContain("GET /api/campaigns/templates");
    expect(FONTE_SERVER).not.toContain('caminhoExato: "/api/campaigns/templates"');
  });

  it("o mapa contém as chaves reais do catálogo e das prévias (incl. a nova do F7)", () => {
    const mapa = mapaAuthPropria();
    expect(mapa).toContain("GET /api/campaigns/template-selecionaveis");
    expect(mapa).toContain("GET /api/campaigns/preview-registro");
    expect(mapa).toContain("POST /api/campaigns/template-preview");
    expect(FONTE_SERVER).toContain('caminhoExato: "/api/campaigns/template-preview"');
  });

  it("nenhuma rota de campanha vira pública: handlers do mapa exigem sessão+papel", () => {
    for (const rota of [
      "/api/campaigns/template-selecionaveis",
      "/api/campaigns/preview-registro",
      "/api/campaigns/template-preview",
      "/api/campaigns/authorize",
      "/api/campaigns/persist",
    ]) {
      const indice = FONTE_SERVER.indexOf(`caminhoExato: "${rota}"`);
      expect(indice).toBeGreaterThan(0);
      expect(FONTE_SERVER.slice(indice, indice + 700).includes("exigirOperadorCampanha")).toBe(true);
    }
  });

  it("sem sessão individual as rotas do mapa permanecem 401 (Bearer não é fallback)", async () => {
    process.env.OPERATOR_TOKEN = "token-legado-nao-usado-c2";
    for (const [metodo, rota] of [
      ["GET", "/api/campaigns/template-selecionaveis"],
      ["GET", "/api/campaigns/preview-registro"],
      ["POST", "/api/campaigns/template-preview"],
    ] as const) {
      const resposta = await despachar(metodo, rota, {
        headers: { authorization: "Bearer token-legado-nao-usado-c2" },
        corpo: Buffer.from("{}"),
      });
      expect(resposta.status).toBe(401);
      expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
    }
    delete process.env.OPERATOR_TOKEN;
  });
});

// ---------------------------------------------------------------------------
// F3 — AUTHORIZE_PERSIST_CANONICAL_EQUIVALENCE (provas funcionais sem banco)
// ---------------------------------------------------------------------------
describe("GF3 C2 F3 — AUTHORIZE_PERSIST_CANONICAL_EQUIVALENCE (autoridade única)", () => {
  beforeAll(() => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
  });

  afterAll(() => {
    if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DB_URL_AMBIENTE;
  });

  it("fonte: authorize NÃO tem segundo validador — usa validarSubmissaoAprovacao e hash sobre registros normalizados", () => {
    const indice = FONTE_SERVER.indexOf('caminhoExato: "/api/campaigns/authorize"');
    const recorte = FONTE_SERVER.slice(indice, FONTE_SERVER.indexOf('caminhoExato: "/api/campaigns/template-preview"', indice));
    expect(recorte).toContain("validarSubmissaoAprovacao(body)");
    expect(recorte).toContain("registros: submissaoRegistros");
    // O loop próprio de validação de campos foi removido:
    expect(recorte).not.toContain("registros.every(");
    // Nunca hasheia o bruto (cast direto de registros crus):
    expect(recorte).not.toContain("registros as RegistroHashAprovacao[]");
  });

  it("sessão de formato válido sem banco → 503 fail-closed (rota protegida antes do handler)", async () => {
    const resposta = await despachar("POST", "/api/campaigns/authorize", {
      headers: { cookie: `__Host-ic_campaign_operator_session=${"A".repeat(43)}` },
      corpo: Buffer.from(JSON.stringify(entradaAprovacao())),
    });
    expect(resposta.status).toBe(503);
    expect(resposta.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
  });

  it("equivalência lógica: entradas brutas equivalentes ⇒ MESMO hash da autoridade", () => {
    const entrada = entradaAprovacao();
    const brutoA = JSON.parse(JSON.stringify(entrada)) as { registros: Record<string, unknown>[] };
    const brutoB = JSON.parse(JSON.stringify(entrada)) as { registros: Record<string, unknown>[] };
    // B: logicamente equivalente a A — ruído que a AUTORIDADE remove
    // (whitespace em campos de exibição), ordem de propriedades diversa e
    // chave extra ignorada. Nome/e-mail não são trimados pela autoridade
    // (permanecem idênticos nos dois brutos — nada é inventado aqui).
    brutoB.registros = brutoB.registros.map((registro, indiceRegistro) => ({
      zzz_extra: "ignorado-pela-autoridade",
      email_normalizado: registro.email_normalizado,
      status_validacao: registro.status_validacao,
      exibicao:
        indiceRegistro === 0
          ? {
              telefone: "  (00) 00000-0001  ",
              cep: " 00000-001 ",
              logradouro: " Rua da Previa ",
              numero: " 101 ",
              bairro: " Bairro Sintetico ",
              cidade: "Salvador",
              uf: " BA ",
            }
          : { cidade: "  Salvador  ", uf: "BA" },
      nome: registro.nome,
      profissional_id: registro.profissional_id,
    }));
    // A autoridade (validarSubmissaoAprovacao) normaliza ambos ao MESMO hash;
    // qualquer divergência estrutural real ⇒ rejeitada antes do hash.
    expect(hashAutoridade(brutoB.registros)).toBe(hashAutoridade(brutoA.registros));
    // E o hash da autoridade É o hash V2 canônico sobre os registros limpos:
    expect(hashAutoridade(brutoA.registros)).toBe(
      hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V2,
        templateVersao: TEMPLATE_V2,
        templateContentHash: contentHashDoTemplateSelecionado(TEMPLATE_V2),
        registros: entrada.registros,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// F2/F3/F7 — bloco DB-gated (CI/PostgreSQL 16): sessões individuais reais
// ---------------------------------------------------------------------------
describeDb("GF3 C2 — matriz de papéis e prévia pré-aprovação (PostgreSQL 16)", () => {
  const ORIGINAL_ENV = {
    persist: process.env.PF_CAMPAIGN_PERSIST_ENABLED,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
    process.env.PF_CAMPAIGN_PERSIST_ENABLED = "true";
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despacharAtivo = servidor.despachar;
  });

  afterAll(() => {
    if (ORIGINAL_ENV.persist === undefined) delete process.env.PF_CAMPAIGN_PERSIST_ENABLED;
    else process.env.PF_CAMPAIGN_PERSIST_ENABLED = ORIGINAL_ENV.persist;
    if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DB_URL_AMBIENTE;
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
        [operatorId, `ADMIN-${suffix}`, "Administrador Individual Sintetico C2", now],
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
    roles: string[],
  ): Promise<{ operatorId: string; cookie: string }> {
    const rawCredential = `Op_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const resposta = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: `OP-C2-${suffix}`,
        displayName: `Operador C2 ${suffix}`,
        roles,
        credentialHash: sha(rawCredential),
      })),
    });
    expect(resposta.status).toBe(201);
    const operatorId = (JSON.parse(resposta.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
    });
    expect(login.status).toBe(200);
    return { operatorId, cookie: firstCookie(login.headers["set-cookie"]) };
  }

  it("F2 — catálogo: PREPARADOR/APROVADOR/REVISOR 200; EXECUTOR/ADMIN_TECNICO 403", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionar(adminCookie, ["PREPARADOR"]);
    const aprovador = await provisionar(adminCookie, ["APROVADOR"]);
    const revisor = await provisionar(adminCookie, ["REVISOR"]);
    const executor = await provisionar(adminCookie, ["EXECUTOR"]);

    for (const papel of [preparador, aprovador, revisor]) {
      const resposta = await despachar("GET", "/api/campaigns/template-selecionaveis", {
        headers: { cookie: papel.cookie },
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as { templates: readonly { templateVersao: string }[] };
      expect(corpo.templates.length).toBeGreaterThan(0);
    }
    for (const cookie of [executor.cookie, adminCookie]) {
      const resposta = await despachar("GET", "/api/campaigns/template-selecionaveis", {
        headers: { cookie },
      });
      expect(resposta.status).toBe(403);
      expect(resposta.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");
    }
  });

  it("F3 — jornada autoridade única: authorize normalizado == hash canônico; persist idempotente com hash da autoridade", async () => {
    const adminCookie = await bootstrapAdmin();
    const preparador = await provisionar(adminCookie, ["PREPARADOR"]);
    const aprovador = await provisionar(adminCookie, ["APROVADOR"]);
    const entrada = entradaAprovacao();

    // PREPARADOR não autoriza (contrato existente preservado):
    const negado = await despachar("POST", "/api/campaigns/authorize", {
      headers: { cookie: preparador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(entrada)),
    });
    expect(negado.status).toBe(403);

    // APROVADOR autoriza com input logicamente equivalente (ruído apenas em
    // campos que a AUTORIDADE normaliza — exibição; nome/e-mail intactos):
    const ruidoso = JSON.parse(JSON.stringify(entrada)) as { registros: Record<string, unknown>[] };
    ruidoso.registros = ruidoso.registros.map((registro, indiceRegistro) => ({
      zzz_extra: "ignorado",
      ...registro,
      exibicao:
        indiceRegistro === 0
          ? { uf: " BA ", telefone: " (00) 00000-0001 ", cidade: "Salvador", cep: "00000-001", logradouro: "Rua da Previa", numero: "101", bairro: "Bairro Sintetico" }
          : { cidade: " Salvador ", uf: "BA" },
    }));
    const autorizado = await despachar("POST", "/api/campaigns/authorize", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(ruidoso)),
    });
    expect(autorizado.status).toBe(200);
    const corpoAutorizado = JSON.parse(autorizado.corpo) as { conteudoHash: string; totalItens: number };
    // O hash devolvido é EXATAMENTE o hash da autoridade sobre o normalizado:
    expect(corpoAutorizado.conteudoHash).toBe(hashAutoridade(entrada.registros));
    expect(corpoAutorizado.totalItens).toBe(entrada.registros.length);

    // Persist com o MESMO conteúdo ⇒ aceito (hash recalculado pela autoridade):
    const persistido = await despachar("POST", "/api/campaigns/persist", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        fingerprintArquivo: sha(`fingerprint-c2-${randomUUID()}`),
        templateVersao: entrada.templateVersao,
        conteudoHash: corpoAutorizado.conteudoHash,
        registros: entrada.registros,
        decisoes: [],
      })),
    });
    expect([200, 201]).toContain(persistido.status);
    const corpoPersistido = JSON.parse(persistido.corpo) as { conteudoHash: string };
    expect(corpoPersistido.conteudoHash).toBe(corpoAutorizado.conteudoHash);

    // Persist com conteúdo divergente do hash submetido ⇒ 409 (consistência):
    const rejeitado = await despachar("POST", "/api/campaigns/persist", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        fingerprintArquivo: sha(`fingerprint-c2-b-${randomUUID()}`),
        templateVersao: entrada.templateVersao,
        conteudoHash: "f".repeat(64),
        registros: entrada.registros.map((registro) => ({ ...registro, nome: `${registro.nome} Alterado` })),
        decisoes: [],
      })),
    });
    expect(rejeitado.status).toBe(409);
    expect(rejeitado.corpo).toContain("CAMPAIGN_APPROVAL_STALE");
  });

  it("F7 — template-preview: renderiza por índice, rejeita índice/payload inválidos; sem persistência", async () => {
    const adminCookie = await bootstrapAdmin();
    const aprovador = await provisionar(adminCookie, ["APROVADOR"]);
    const executor = await provisionar(adminCookie, ["EXECUTOR"]);
    const entrada = entradaAprovacao();
    const payload = (indice: number) => ({
      templateVersao: entrada.templateVersao,
      previaIndice: indice,
      registros: entrada.registros,
    });

    // EXECUTOR não tem papel de leitura/revisão (F2) ⇒ 403:
    const negado = await despachar("POST", "/api/campaigns/template-preview", {
      headers: { cookie: executor.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(payload(1))),
    });
    expect(negado.status).toBe(403);

    const ok = await despachar("POST", "/api/campaigns/template-preview", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(payload(1))),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toContain("no-store");
    const previa1 = JSON.parse(ok.corpo) as {
      templateVersao: string;
      templateContentHash: string;
      dataMode: string;
      assunto: string;
      mensagem: { subject: string; textBody: string; htmlBody: string };
    };
    expect(previa1.templateVersao).toBe(TEMPLATE_V2);
    expect(previa1.templateContentHash).toBe(contentHashDoTemplateSelecionado(TEMPLATE_V2));
    expect(previa1.assunto.length).toBeGreaterThan(0);
    expect(previa1.mensagem.subject.length).toBeGreaterThan(0);
    expect(previa1.mensagem.textBody).toContain("Ana Sintetica");
    expect(previa1.mensagem.htmlBody.length).toBeGreaterThan(0);

    // Navegação por índice: registro 2 ⇒ conteúdo DIFERENTE (nada de linha=1):
    const ok2 = await despachar("POST", "/api/campaigns/template-preview", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify(payload(2))),
    });
    expect(ok2.status).toBe(200);
    const previa2 = JSON.parse(ok2.corpo) as { mensagem: { textBody: string } };
    expect(previa2.mensagem.textBody).toContain("Bruno Sintetico");
    expect(previa2.mensagem.textBody).not.toBe(previa1.mensagem.textBody);

    // Bounds: 0, 3 (> total) e não-inteiro ⇒ 422 sanitizado:
    for (const indice of [0, 3, 1.5]) {
      const fora = await despachar("POST", "/api/campaigns/template-preview", {
        headers: { cookie: aprovador.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify(payload(indice))),
      });
      expect(fora.status).toBe(422);
      expect(fora.corpo).toContain("CAMPAIGN_TEMPLATE_PREVIEW_INDEX_INVALID");
    }
    // Payload que a autoridade rejeita (status != APTO) ⇒ 422:
    const invalido = await despachar("POST", "/api/campaigns/template-preview", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        templateVersao: entrada.templateVersao,
        previaIndice: 1,
        registros: [{ ...entrada.registros[0], status_validacao: "BLOQUEADO" }],
      })),
    });
    expect(invalido.status).toBe(422);
    expect(invalido.corpo).toContain("CAMPAIGN_TEMPLATE_PREVIEW_INVALID");
    // Template não registrada ⇒ 422:
    const templateInvalida = await despachar("POST", "/api/campaigns/template-preview", {
      headers: { cookie: aprovador.cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        templateVersao: "template-inexistente-c2",
        previaIndice: 1,
        registros: entrada.registros,
      })),
    });
    expect(templateInvalida.status).toBe(422);
  });
});
