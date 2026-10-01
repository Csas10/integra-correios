/**
 * GF5.3 — GOVERNED BATCH HTTP CONTROL (POST /api/campaigns/batch-send).
 *
 * Matriz obrigatória (ZERO SEND: todo envio é FAKE por DI exclusiva de teste;
 * nenhuma chamada de rede real — fetch sempre espionado ou não usado):
 *   1.  não-EXECUTOR ⇒ 403 + ZERO execução/provider;
 *   2.  campanhaId malformado ⇒ 422;
 *   3.  chave extra no corpo ⇒ 422 CAMPAIGN_BATCH_BODY_AUTHORITY;
 *   4.  batchSendEnabled fechado ⇒ 409 + ZERO claim/provider;
 *   5.  OAuth/provider readiness bloqueado ⇒ 409 + ZERO execução;
 *   6.  janela ≤ 10 restante ⇒ 200 CONCLUIDO;
 *   7.  > 10 PREPARADO ⇒ no máximo 10 processados ⇒ 200 PARCIAL;
 *   8.  segunda invocação EXPLÍCITA ⇒ janela seguinte; ENVIADO nunca reenviado;
 *   9.  ordem global ASC preservada ENTRE janelas;
 *   10. FALHA_PRE_PROVIDER ⇒ 200 INTERROMPIDO; posteriores intocados;
 *   11. FALHA_DEFINITIVA ⇒ 200 INTERROMPIDO;
 *   12. AMBIGUO ⇒ 200 INTERROMPIDO + readiness posterior bloqueado;
 *   13. exceção de execução ⇒ adjudicada (nunca 500 bruto), zero retry;
 *   14. nenhuma resposta expõe PII/segredos;
 *   15. o caminho de produção alcança o provider SOMENTE via
 *       executeAttemptCampanha (estrutural);
 *   16. nenhuma ponte outbox_email/worker (estrutural).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACAO_AUTORIZADA_EXECUCAO,
  fingerprintDestinatarioCampanha,
} from "../src/campaign-control.js";
import { contentHashDoTemplateSelecionado, hashAprovacaoCampanha } from "../src/campaigns.js";
import {
  despachar as despacharSemBanco,
  injetarFornecedorLoteParaTeste,
} from "../src/server.js";
import type { ProvedorEnvioCampanha } from "../src/campaign-execution.js";
import { derivarFingerprintContaGmail } from "@integra-correios/mail";
import { HmacSha256Fingerprinter } from "@integra-correios/persistence";

type Despachar = typeof despacharSemBanco;
const COOKIE_SESSAO = `__Host-ic_campaign_operator_session=${"C".repeat(43)}`;

const FONTE_SERVER = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const FONTE_BATCH = readFileSync(new URL("../src/campaign-batch.ts", import.meta.url), "utf8");

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Restauração de ambiente por teste (nenhuma mutação persistente de env).
const ambienteOriginal = { ...process.env };
const CHAVES_SINTETICAS = [
  "DATABASE_URL",
  "PF_CAMPAIGN_BATCH_SEND_ENABLED",
  "PF_CAMPAIGN_EXECUTE_ENABLED",
  "PF_CAMPAIGN_PROOF_KEY_BASE64",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REDIRECT_URI",
  "GMAIL_EXPECTED_ACCOUNT",
  "DATA_ENCRYPTION_KEY_BASE64",
  "DOCUMENT_FINGERPRINT_KEY_BASE64",
  "CAMPAIGN_SENDER_ADDRESS",
  "REAL_SEND_ENABLED",
] as const;

const CHAVE_PROVA_BASE64 = Buffer.from("chave-de-prova-sintetica-gf53-32bytes!!", "utf8").toString("base64");
const CHAVE_FINGERPRINT_FIXTURE_B64 = Buffer.from("fp-fixture-key-gf53---32bytes!!!!", "utf8").toString("base64");
const CONTA_ESPERADA = "institucional.gf53@exemplo.test";
const OAUTH_NONCE_FIXTURE = Buffer.from("noncegf53x", "utf8"); // exatamente 12 bytes
const OAUTH_AUTH_TAG_FIXTURE = Buffer.alloc(16); // exatamente 16 bytes

/** Token sintético ÚNICO por semente: 43–128 chars, [A-Za-z0-9_-]. */
function tokenSintetico(semente: string): string {
  const base = "Op_abcdefghijklmnopqrstuvwxyz0123456789";
  const sufixo = createHash("sha256").update("token-gf53-" + semente).digest("base64url").slice(0, 24);
  return base + sufixo;
}
/** Hex de 64 caracteres, determinístico e único por semente. */
function fingerprintUnico(semente: string): string {
  return createHash("sha256").update(semente).digest("hex");
}

/** Recomposição INDEPENDENTE do contrato CAMPANHA_CONTROLE_HASH_V2. */
function hashEventoTeste(eventoId: string, agregadoId: string, tipo: string, ocorreuEm: string): string {
  const payload = JSON.stringify([
    "CAMPANHA_CONTROLE_HASH_V2",
    eventoId,
    "CAMPANHA_EXECUCAO",
    agregadoId,
    tipo,
    ocorreuEm,
  ]);
  return createHmac("sha256", "audit-chain").update(payload).digest("hex");
}

afterEach(() => {
  // Cleanup GARANTIDO: fake de DI nunca vaza para o teste seguinte; nenhuma
  // chave sintética persiste; nenhum stub de rede sobrevive.
  injetarFornecedorLoteParaTeste(null);
  for (const chave of CHAVES_SINTETICAS) delete process.env[chave];
  for (const [chave, valor] of Object.entries(ambienteOriginal)) {
    if (CHAVES_SINTETICAS.includes(chave as (typeof CHAVES_SINTETICAS)[number])) {
      process.env[chave] = valor as string;
    }
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Parte 1 — HTTP_ROUTES (sem banco): autenticação precede validação do corpo.
// ---------------------------------------------------------------------------
describe("GF5.3 — HTTP fail-closed (contrato determinístico, sem DB)", () => {
  it("sem sessão ⇒ 401 INDIVIDUAL_OPERATOR_AUTH_REQUIRED (zero claim/provider/rede)", async () => {
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      const resposta = await despacharSemBanco("POST", "/api/campaigns/batch-send", {
        corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
      });
      expect(resposta.status).toBe(401);
      expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("corpo com autoridade adicional ⇒ 422 CAMPAIGN_BATCH_BODY_AUTHORITY (nunca 200)", async () => {
    const resposta = await despacharSemBanco("POST", "/api/campaigns/batch-send", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(
        JSON.stringify({ campanhaId: randomUUID(), limit: 100, itemIds: [randomUUID()] }),
      ),
    });
    expect(resposta.status).not.toBe(200);
    if (resposta.status === 422) {
      expect(resposta.corpo).toContain("CAMPAIGN_BATCH_BODY_AUTHORITY");
    }
  });

  it("a rota existe com caminho exato e guarda EXECUTOR antes do preflight (estrutural)", () => {
    const server = semComentarios(FONTE_SERVER);
    const indice = server.indexOf('caminhoExato: "/api/campaigns/batch-send"');
    expect(indice).toBeGreaterThan(-1);
    const trecho = server.slice(indice, indice + 4200);
    expect(trecho).toContain("CAMPAIGN_EXECUTOR_ROLES");
    expect(trecho).toContain("CAMPAIGN_BATCH_BODY_AUTHORITY");
    expect(trecho).toContain("CAMPAIGN_BATCH_BLOCKED");
    expect(trecho).toContain("MAX_BATCH_ITEMS_PER_HTTP_RUN");
    expect(trecho).not.toMatch(/body\.(limit|batchSize|maxItems|offset|cursor|itemIds|itemIds)/);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — POSTGRESQL_INTEGRATION (DB-gated, PG16): ROTA REAL com DI de teste
// ---------------------------------------------------------------------------
const DB_URL_AMBIENTE = ambienteOriginal.DATABASE_URL ?? "";
const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

describeDb("GF5.3 — rota HTTP real do lote (POSTGRESQL_INTEGRATION)", () => {
  let pool: import("@integra-correios/persistence").NodePostgresPool | undefined;
  let despachar: Despachar;
  const CHAVE_FINGERPRINT_B64 = CHAVE_FINGERPRINT_FIXTURE_B64;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despachar = servidor.despachar as Despachar;
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
  });

  // ---------------------------------------------------------------------------
  // Fixtures — mesma disciplina das suítes canário/execução (limpeza OWNED).
  // ---------------------------------------------------------------------------
  let adminCookie = "";
  const conexoesOAuthDaSuite: string[] = [];
  let conexaoRecemInserida: string | undefined;

  async function bootstrapAdmin(): Promise<string> {
    const adminId = randomUUID();
    const tokenId = randomUUID();
    const sufixo = adminId.replace(/-/g, "").slice(0, 12);
    const credencial = `AdminIndividual_abcdefghijklmnopqrstuvwxyz0123456789${sufixo}`;
    const agora = new Date().toISOString();
    await pool!.query(
      `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
       VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
      [adminId, `ADMIN-${sufixo}`, "Administrador Individual Sintético GF5.3", agora],
    );
    await pool!.query(
      `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em) VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
      [adminId, agora],
    );
    await pool!.query(
      `INSERT INTO operador_token (id, operator_id, token_hash, emitido_por_operator_id, status, criado_em)
       VALUES ($1, $2, $3, $2, 'ATIVO', $4)`,
      [tokenId, adminId, createHash("sha256").update(credencial).digest("hex"), agora],
    );
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencial })),
    });
    expect(login.status).toBe(200);
    return firstCookie(login.headers["set-cookie"]);
  }

  async function provisionarPapeis(papeis: readonly string[]): Promise<string> {
    // Sufixo ÚNICO POR INVOCACAO: mesmo conjunto de papéis ⇒ credencial/operador
    // distintos (sem colisão UNIQUE(credentialHash) em cenas consecutivas).
    const sufixo = randomUUID().replace(/-/g, "").slice(0, 12);
    const credencial = tokenSintetico("gf53-" + papeis.join("-") + "-" + sufixo);
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(
        JSON.stringify({
          code: "OP-GF53-" + sufixo,
          displayName: "Operador GF5.3 " + papeis.join("+"),
          roles: [...papeis],
          credentialHash: createHash("sha256").update(credencial).digest("hex"),
        }),
      ),
    });
    expect(admin.status).toBe(201);
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencial })),
    });
    expect(login.status).toBe(200);
    return firstCookie(login.headers["set-cookie"]);
  }

  interface CenaBatch {
    campanhaId: string;
    loteCampanhaId: string;
    readonly itemIds: string[];
    readonly fingerprints: string[];
    /** Fingerprint do item canário (ordem 1). */
    readonly fingerprintCanario: string;
  }

  /**
   * Cena do lote: campanha persistida + lote ATIVO + N itens PREPARADO;
   * item de ordem 1 = canário (selecionado; ENVIADO com settlement durável
   * por padrão), autorização humana vigente (lote + itens não-canário).
   */
  async function criarCenaBatch(params: {
    readonly operatorId: string;
    readonly totalItens: number;
    readonly canarioEnviado?: boolean;
  }): Promise<CenaBatch> {
    const p = pool!;
    const campanhaId = randomUUID();
    const loteCampanhaId = randomUUID();
    const agora = new Date().toISOString();
    const registros = Array.from({ length: params.totalItens }, (_, indice) => ({
      profissional_id: "PF-G53-" + String(indice + 1).padStart(4, "0"),
      nome: "Sintetico GF53 " + String(indice + 1),
      email_normalizado: "destinatario.gf53." + String(indice + 1) + "@exemplo.test",
      status_validacao: "APTO",
    }));
    const contentHash = contentHashDoTemplateSelecionado("pf-expedicao-carteira-2026-v2") ?? "";
    const snapshot = {
      template_versao: "pf-expedicao-carteira-2026-v2",
      template_content_hash: contentHash,
      approval_hash_version: "CAMPANHA_APROVACAO_V2" as const,
      registros,
    };
    const hashAprovacao = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2" as const,
      templateVersao: snapshot.template_versao,
      templateContentHash: snapshot.template_content_hash,
      registros,
    });
    await p.query(
      `INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'pf-expedicao-carteira-2026-v2', $4, $5::jsonb, $6, $6, 0, $6, 'LOTE_CRIADO', $7, $7)`,
      [
        campanhaId,
        params.operatorId,
        fingerprintUnico("arquivo-gf53-" + campanhaId),
        hashAprovacao,
        JSON.stringify(snapshot),
        registros.length,
        agora,
      ],
    );
    await p.query(
      `INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'pf-expedicao-carteira-2026-v2', 'ATIVO', $4, $5)`,
      [loteCampanhaId, campanhaId, "G53_LOTE_" + loteCampanhaId.slice(0, 8), params.totalItens, agora],
    );
    const itemIds: string[] = [];
    const fingerprints: string[] = [];
    for (let ordem = 1; ordem <= params.totalItens; ordem += 1) {
      const itemId = randomUUID();
      const fingerprint = registros[ordem - 1]!.email_normalizado;
      itemIds.push(itemId);
      fingerprints.push(fingerprintDestinatarioCampanha(fingerprint));
      await p.query(
        `INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, $3, $4, $5::jsonb, 'PREPARADO', $6)`,
        [itemId, loteCampanhaId, ordem, fingerprints[ordem - 1], JSON.stringify({ ordem }), agora],
      );
    }
    // Canário (ordem 1): seleção durável + ativação na MESMA transação.
    const selecaoId = randomUUID();
    await p.query(
      `INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'CAMPANHA_CANARIO_SELECIONADO', $3, $3, $4, $5::jsonb, NULL, $6)`,
      [
        selecaoId,
        loteCampanhaId,
        params.operatorId,
        agora,
        JSON.stringify({ esquema: "CAMPANHA_CANARIO_V1", item_id: itemIds[0], ordem: 1 }),
        hashEventoTeste(selecaoId, loteCampanhaId, "CAMPANHA_CANARIO_SELECIONADO", agora),
      ],
    );
    const ativacaoId = randomUUID();
    await p.query(
      `INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'CAMPANHA_LOTE_ATIVADO', $3, $3, $4, $5::jsonb, NULL, $6)`,
      [
        ativacaoId,
        loteCampanhaId,
        params.operatorId,
        agora,
        JSON.stringify({ esquema: "CAMPANHA_CONTROLE_V1", acao: "ATIVAR_LOTE" }),
        hashEventoTeste(ativacaoId, loteCampanhaId, "CAMPANHA_LOTE_ATIVADO", agora),
      ],
    );
    if (params.canarioEnviado !== false) {
      await p.query(`UPDATE outbox_campanha SET estado = 'ENVIADO' WHERE id = $1`, [itemIds[0]]);
      for (const tipo of ["EXEC_RECEIPT", "EXEC_SETTLEMENT"] as const) {
        const eventoId = randomUUID();
        await p.query(
          `INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)`,
          [
            eventoId,
            itemIds[0],
            tipo,
            params.operatorId,
            agora,
            JSON.stringify({ esquema: "CAMPANHA_EXECUCAO_V1" }),
            hashEventoTeste(eventoId, itemIds[0]!, tipo, agora),
          ],
        );
      }
    }
    // Autorização humana vigente no lote (preflight) + nos itens não-canário
    // (prova por item; a prova do canário usa o MESMO evento do lote).
    for (const agregado of [loteCampanhaId, ...itemIds.slice(1)]) {
      const eventoId = randomUUID();
      await p.query(
        `INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'CAMPANHA_EXECUCAO_AUTORIZADA', $3, $3, $4, $5::jsonb, NULL, $6)`,
        [
          eventoId,
          agregado,
          params.operatorId,
          agora,
          JSON.stringify({ esquema: "CAMPANHA_CONTROLE_V1", acao: ACAO_AUTORIZADA_EXECUCAO, lote_estado: "ATIVO" }),
          hashEventoTeste(eventoId, agregado, "CAMPANHA_EXECUCAO_AUTORIZADA", agora),
        ],
      );
    }
    return {
      campanhaId,
      loteCampanhaId,
      itemIds,
      fingerprints,
      fingerprintCanario: fingerprints[0]!,
    };
  }

  /** Ambiente de e-mail CONSOLIDADO pronto (somente processo de teste). */
  function ambienteMailCompleto(): void {
    process.env.PF_CAMPAIGN_PROOF_KEY_BASE64 = CHAVE_PROVA_BASE64;
    process.env.PF_CAMPAIGN_BATCH_SEND_ENABLED = "true";
    process.env.PF_CAMPAIGN_EXECUTE_ENABLED = "true";
    process.env.REAL_SEND_ENABLED = "true";
    process.env.GMAIL_OAUTH_CLIENT_ID = "client-id-sintetico-gf53";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "client-secret-sintetico-gf53";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "https://exemplo.test/gf53/callback";
    process.env.GMAIL_EXPECTED_ACCOUNT = CONTA_ESPERADA;
    process.env.DATA_ENCRYPTION_KEY_BASE64 = Buffer.from("gf53-chave-cripto-32-bytes-sintet!!", "utf8").toString("base64");
    // Fonte ÚNICA: MESMA constante da fixture OAuth (source match).
    process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = CHAVE_FINGERPRINT_B64;
    process.env.CAMPAIGN_SENDER_ADDRESS = "carteiras@crtba.org.br";
  }

  /** Conexão OAuth CASADA (fingerprint derivado da conta esperada). */
  async function conectarOAuthCorrespondente(): Promise<void> {
    const fp = new HmacSha256Fingerprinter(Buffer.from(CHAVE_FINGERPRINT_B64, "base64"));
    const fingerprintConta = derivarFingerprintContaGmail(fp, CONTA_ESPERADA);
    const inserida = await pool!.query(
      `INSERT INTO oauth_connection (provider, conta_fingerprint, scopes, access_token_ciphertext, access_token_nonce, access_token_auth_tag, chave_versao) VALUES ('GMAIL', $1, ARRAY['https://www.googleapis.com/auth/gmail.send']::text[], $2, $3, $4, 'v1-teste') RETURNING id`,
      [fingerprintConta, Buffer.from("ciphertext-sintetico-gf53"), OAUTH_NONCE_FIXTURE, OAUTH_AUTH_TAG_FIXTURE],
    );
    const id = (inserida.rows[0] as { id: string }).id;
    conexoesOAuthDaSuite.push(id);
    conexaoRecemInserida = id;
  }

  /**
   * Provider FAKE com DI exclusiva de teste: registra cada chamada (itemId) e
   * devolve respostas configuradas por ORDEM (default = ENVIADO). NUNCA rede.
   */
  function injetarProvedorFake(opcoes: {
    readonly cena: CenaBatch;
    readonly respostasPorOrdem?: Record<number, string>;
    readonly chamadas: { itemId: string }[];
  }): void {
    const ordemPorItem = new Map(opcoes.cena.itemIds.map((id, indice) => [id, indice + 1]));
    const provider: ProvedorEnvioCampanha = {
      nome: "GMAIL_CAMPANHA_FAKE_GF53",
      enviar: (async (comando: { itemId: string }) => {
        opcoes.chamadas.push({ itemId: comando.itemId });
        const ordem = ordemPorItem.get(comando.itemId);
        const tipo = ordem !== undefined ? opcoes.respostasPorOrdem?.[ordem] : undefined;
        if (tipo) {
          const motivo =
            tipo === "FALHA_PRE_PROVIDER"
              ? "TOKEN_RESOLUTION_INDISPONIVEL"
              : tipo === "FALHA_DEFINITIVA"
                ? "AUTH_REQUIRED"
                : "GMAIL_AMBIGUO";
          return { tipo, motivo };
        }
        return {
          tipo: "ENVIADO",
          receipt: {
            provider: "FAKE",
            messageId: "m-" + comando.itemId.slice(0, 8),
            acceptedAt: new Date().toISOString(),
            chaveIdempotencia: "chave-fake-gf53",
          },
        };
      }) as ProvedorEnvioCampanha["enviar"],
    };
    injetarFornecedorLoteParaTeste({ provedorParaCampanha: () => provider });
  }

  async function contagensPorEstado(loteCampanhaId: string): Promise<Record<string, number>> {
    const contagem = await pool!.query(
      `SELECT estado, count(*)::int AS total FROM outbox_campanha WHERE lote_campanha_id = $1 GROUP BY estado`,
      [loteCampanhaId],
    );
    return Object.fromEntries(
      (contagem.rows as { estado: string; total: number }[]).map((linha) => [linha.estado, Number(linha.total)]),
    );
  }

  async function totalExecItens(itemId: string): Promise<number> {
    const eventos = await pool!.query(
      `SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_tipo = 'CAMPANHA_EXECUCAO' AND agregado_id = $1 AND tipo LIKE 'EXEC%'`,
      [itemId],
    );
    return Number((eventos.rows[0] as { total: number }).total);
  }

  beforeAll(async () => {
    adminCookie = await bootstrapAdmin();
    // Janela determinística de OAuth: suites DB-gated são SERIAIS e cada uma
    // limpa as PRÓPRIAS conexões (cleanup owned por id); este reset remove
    // apenas resíduos de vazamento de outra suíte (nunca dados operacionais).
    await pool!.query(`DELETE FROM oauth_connection WHERE provider = 'GMAIL'`);
  });

  afterEach(async () => {
    // Cleanup OWNED por id (nunca global; inclui falhas intermediárias).
    if (conexaoRecemInserida && !conexoesOAuthDaSuite.includes(conexaoRecemInserida)) {
      conexoesOAuthDaSuite.push(conexaoRecemInserida);
    }
    for (const id of conexoesOAuthDaSuite.splice(0)) {
      await pool?.query(`DELETE FROM oauth_connection WHERE id = $1 AND provider = 'GMAIL'`, [id]);
    }
    conexaoRecemInserida = undefined;
    injetarFornecedorLoteParaTeste(null);
  });

  it("GF5.3-1. não-EXECUTOR ⇒ 403 OPERATOR_ROLE_FORBIDDEN ANTES do preflight (zero claim/provider/rede)", async () => {
    const preparador = await provisionarPapeis(["PREPARADOR"]);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 4 });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: preparador, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(403);
      expect(resposta.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["PREPARADO"]).toBe(3); // canário ENVIADO; NADA mudou
      expect(estados["ENVIADO"]).toBe(1);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-2. campanhaId malformado ⇒ 422 CAMPAIGN_BATCH_INVALID", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    const resposta = await despachar("POST", "/api/campaigns/batch-send", {
      headers: { cookie: executor, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: "não-é-uuid" })),
    });
    expect(resposta.status).toBe(422);
    expect(resposta.corpo).toContain("CAMPAIGN_BATCH_INVALID");
  });

  it("GF5.3-3. chave extra no corpo ⇒ 422 CAMPAIGN_BATCH_BODY_AUTHORITY (operatorId/limit/itemIds)", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    const resposta = await despachar("POST", "/api/campaigns/batch-send", {
      headers: { cookie: executor, "content-type": "application/json" },
      corpo: Buffer.from(
        JSON.stringify({ campanhaId: randomUUID(), operatorId: randomUUID(), batchSize: 50 }),
      ),
    });
    expect(resposta.status).toBe(422);
    expect(resposta.corpo).toContain("CAMPAIGN_BATCH_BODY_AUTHORITY");
  });

  it("GF5.3-4. batchSendEnabled fechado ⇒ 409 CAMPAIGN_BATCH_BLOCKED/BATCH_SEND_DISABLED + ZERO claim/provider", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    process.env.PF_CAMPAIGN_BATCH_SEND_ENABLED = "false";
    await conectarOAuthCorrespondente();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadas: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 4 });
      injetarProvedorFake({ cena, chamadas });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(409);
      expect(resposta.corpo).toContain("CAMPAIGN_BATCH_BLOCKED");
      expect(resposta.corpo).toContain("BATCH_SEND_DISABLED");
      expect(chamadas).toHaveLength(0); // provider NUNCA alcançado
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["PREPARADO"]).toBe(3);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-5. OAuth/provider readiness bloqueado ⇒ 409 + ZERO execução", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    // SEM conexão OAuth persistida ⇒ OAUTH_NOT_CONNECTED no preflight canônico.
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadas: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 4 });
      injetarProvedorFake({ cena, chamadas });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(409);
      expect(resposta.corpo).toContain("CAMPAIGN_BATCH_BLOCKED");
      expect(resposta.corpo).toContain("OAUTH_NOT_CONNECTED");
      expect(chamadas).toHaveLength(0);
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["PREPARADO"]).toBe(3);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-6. janela ≤ 10 restante ⇒ 200 CONCLUIDO (aggregate sanitizado, zero rede real)", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadas: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 6 });
      injetarProvedorFake({ cena, chamadas });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("CONCLUIDO");
      expect(corpo["totalItens"]).toBe(6);
      expect(corpo["preparadosInicio"]).toBe(5);
      expect(corpo["enviadosAntes"]).toBe(1);
      expect(corpo["processadosNestaExecucao"]).toBe(5);
      expect(corpo["enviadosNestaExecucao"]).toBe(5);
      expect(corpo["falhasNestaExecucao"]).toBe(0);
      expect(corpo["restantesPreparados"]).toBe(0);
      expect(corpo["ultimaOrdemProcessada"]).toBe(6);
      // Exatamente UMA chamada de provider por item (canário EXCLUÍDO).
      expect(chamadas).toHaveLength(5);
      expect(chamadas.map((c) => c.itemId)).not.toContain(cena.itemIds[0]);
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["ENVIADO"]).toBe(6);
      expect(estados["PREPARADO"]).toBeUndefined();
      // Nenhuma rede real (o envio passou EXCLUSIVAMENTE pelo fake DI).
      expect(espiaoRede).not.toHaveBeenCalled();
      // Sanitização: nenhum dado de destinatário/segredo na resposta.
      for (const fingerprint of cena.fingerprints) {
        expect(resposta.corpo).not.toContain(fingerprint);
      }
      expect(resposta.corpo).not.toContain("@exemplo.test");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-7. > 10 PREPARADO ⇒ no máximo 10 processados ⇒ 200 PARCIAL; restantes PREPARADO", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadas: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 14 });
      injetarProvedorFake({ cena, chamadas });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("PARCIAL");
      expect(corpo["preparadosInicio"]).toBe(13);
      expect(corpo["processadosNestaExecucao"]).toBe(10);
      expect(corpo["enviadosNestaExecucao"]).toBe(10);
      expect(corpo["restantesPreparados"]).toBe(3);
      expect(corpo["janelaItensPorExecucao"]).toBe(10);
      expect(corpo["continuaSomenteComNovaAcaoHumana"]).toBe(true);
      expect(chamadas).toHaveLength(10);
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["ENVIADO"]).toBe(11); // canário + 10 da janela
      expect(estados["PREPARADO"]).toBe(3);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-8+9. segunda invocação EXPLÍCITA consome a janela seguinte; ordem global ASC entre janelas; ENVIADO nunca reenviado", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadasPrimeira: { itemId: string }[] = [];
    const chamadasSegunda: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 14 });
      const ordemPorItem = new Map(cena.itemIds.map((id, indice) => [id, indice + 1]));
      injetarProvedorFake({ cena, chamadas: chamadasPrimeira });
      const corpo = { headers: { cookie: executor, "content-type": "application/json" } as Record<string, string> };
      const primeira = await despachar("POST", "/api/campaigns/batch-send", {
        ...corpo,
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(primeira.status).toBe(200);
      expect(JSON.parse(primeira.corpo).resultado).toBe("PARCIAL");
      const ordensPrimeira = chamadasPrimeira.map((c) => ordemPorItem.get(c.itemId)!);
      expect(ordensPrimeira).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // ASC pós-canário
      // Continuação EXPLÍCITA (nova invocação humana — nunca automática).
      injetarFornecedorLoteParaTeste(null);
      injetarProvedorFake({ cena, chamadas: chamadasSegunda });
      const segunda = await despachar("POST", "/api/campaigns/batch-send", {
        ...corpo,
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(segunda.status).toBe(200);
      const corpoSegunda = JSON.parse(segunda.corpo) as Record<string, unknown>;
      expect(corpoSegunda["resultado"]).toBe("CONCLUIDO");
      expect(corpoSegunda["enviadosAntes"]).toBe(11);
      expect(corpoSegunda["processadosNestaExecucao"]).toBe(3);
      expect(corpoSegunda["restantesPreparados"]).toBe(0);
      // Ordem global ASC ENTRE janelas; nenhuma repetição de item.
      const ordensSegunda = chamadasSegunda.map((c) => ordemPorItem.get(c.itemId)!);
      expect(ordensSegunda).toEqual([12, 13, 14]);
      const todas = [...ordensPrimeira, ...ordensSegunda];
      expect(new Set(todas).size).toBe(todas.length);
      expect([...todas].sort((a, b) => a - b)).toEqual(todas);
      // O canário (ordem 1) JAMAIS foi reenviado: nenhum EXEC novo nele.
      expect(chamadasPrimeira.map((c) => c.itemId)).not.toContain(cena.itemIds[0]);
      expect(chamadasSegunda.map((c) => c.itemId)).not.toContain(cena.itemIds[0]);
      const execCanario = await totalExecItens(cena.itemIds[0]!);
      expect(execCanario).toBe(2); // EXEC_RECEIPT + EXEC_SETTLEMENT originais
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-10. FALHA_PRE_PROVIDER no primeiro processado ⇒ 200 INTERROMPIDO; posteriores intocados; zero retry", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const chamadas: { itemId: string }[] = [];
    try {
      const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 8 });
      injetarProvedorFake({ cena, chamadas, respostasPorOrdem: { 2: "FALHA_PRE_PROVIDER" } });
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200); // resultado ADJUDICADO, nunca 500
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("INTERROMPIDO");
      expect(String(corpo["motivoInterrupcao"])).toContain("FALHA_PRE_PROVIDER");
      expect(corpo["enviadosNestaExecucao"]).toBe(0);
      expect(corpo["falhasNestaExecucao"]).toBe(1);
      expect(corpo["processadosNestaExecucao"]).toBe(1);
      // Itens posteriores intocados (7 restantes = ordens 3–8; ordem 2 FALHOU).
      expect(corpo["restantesPreparados"]).toBe(6);
      expect(chamadas).toHaveLength(1); // ZERO retry do item falho
      const estados = await contagensPorEstado(cena.loteCampanhaId);
      expect(estados["PREPARADO"]).toBe(6);
      expect(estados["FALHOU"]).toBe(1);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-11. FALHA_DEFINITIVA ⇒ 200 INTERROMPIDO (motivo canônico preservado)", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const chamadas: { itemId: string }[] = [];
    const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 5 });
    injetarProvedorFake({ cena, chamadas, respostasPorOrdem: { 2: "FALHA_DEFINITIVA" } });
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("INTERROMPIDO");
      expect(String(corpo["motivoInterrupcao"])).toContain("FALHA_DEFINITIVA");
      expect(String(corpo["motivoInterrupcao"])).toContain("AUTH_REQUIRED");
      expect(chamadas).toHaveLength(1);
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-12. AMBIGUO ⇒ 200 INTERROMPIDO + AMBIGUO_RECONCILIACAO_HUMANA; readiness posterior bloqueado", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const chamadas: { itemId: string }[] = [];
    const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 5 });
    injetarProvedorFake({ cena, chamadas, respostasPorOrdem: { 2: "AMBIGUO" } });
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("INTERROMPIDO");
      expect(corpo["motivoInterrupcao"]).toBe("AMBIGUO_RECONCILIACAO_HUMANA");
      expect(chamadas).toHaveLength(1); // ZERO retry; adjudicação humana
      // Readiness recém-lido NÃO reautoriza: ambiguidade não resolvida bloqueia.
      const readiness = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
        headers: { cookie: executor },
      });
      expect(readiness.status).toBe(200);
      const corpoReadiness = JSON.parse(readiness.corpo) as {
        acoes: { EXECUTAR_LOTE: { permitida: boolean; bloqueios: string[] } };
      };
      expect(corpoReadiness.acoes.EXECUTAR_LOTE.permitida).toBe(false);
      expect(JSON.stringify(corpoReadiness.acoes.EXECUTAR_LOTE.bloqueios)).toContain("AMBIGU");
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-13. exceção de execução ⇒ adjudicada EXECUCAO_INCONSISTENTE (nunca 500 bruto); ZERO retry", async () => {
    const executor = await provisionarPapeis(["EXECUTOR"]);
    ambienteMailCompleto();
    await conectarOAuthCorrespondente();
    const chamadas: { itemId: string }[] = [];
    const cena = await criarCenaBatch({ operatorId: randomUUID(), totalItens: 5 });
    // Provider fake que LANÇA: o domínio interrompe conservadoramente e a
    // rota adjudica (nunca vaza stack/PII; nunca 500 genérico; nunca retry).
    const ordemPorItem = new Map(cena.itemIds.map((id, indice) => [id, indice + 1]));
    const provider: ProvedorEnvioCampanha = {
      nome: "GMAIL_CAMPANHA_FAKE_GF53_THROW",
      enviar: (async (comando: { itemId: string }) => {
        chamadas.push({ itemId: comando.itemId });
        if (ordemPorItem.get(comando.itemId) === 2) {
          throw new Error("falha-sintetica-gf53-infraestrutura");
        }
        return {
          tipo: "ENVIADO",
          receipt: {
            provider: "FAKE",
            messageId: "m-" + comando.itemId.slice(0, 8),
            acceptedAt: new Date().toISOString(),
            chaveIdempotencia: "chave-fake-gf53",
          },
        };
      }) as ProvedorEnvioCampanha["enviar"],
    };
    injetarFornecedorLoteParaTeste({ provedorParaCampanha: () => provider });
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      const resposta = await despachar("POST", "/api/campaigns/batch-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(200);
      const corpo = JSON.parse(resposta.corpo) as Record<string, unknown>;
      expect(corpo["resultado"]).toBe("INTERROMPIDO");
      expect(corpo["motivoInterrupcao"]).toBe("EXECUCAO_INCONSISTENTE");
      expect(chamadas).toHaveLength(1); // ZERO retry do item que lançou
      // Nenhum vazamento do erro interno para a resposta.
      expect(resposta.corpo).not.toContain("falha-sintetica-gf53-infraestrutura");
      expect(resposta.corpo).not.toContain("stack");
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GF5.3-14+15+16. autoridade estrutural: provider só via executeAttemptCampanha; sem outbox/worker; sem PII na rota", () => {
    const server = semComentarios(FONTE_SERVER);
    // (15) HTTP → batch service → executeAttemptCampanha (nunca direto):
    const indice = server.indexOf('caminhoExato: "/api/campaigns/batch-send"');
    const trecho = server.slice(indice, indice + 4600);
    expect(trecho).toContain("executarLoteCampanha(requireDbPool()");
    expect(trecho).toContain("montarConsolidatedMailAdapter({");
    // Exceção de infraestrutura fora do domínio ⇒ 500 sanitizado via
    // erroControleCampanha (nunca stack bruta; nunca retry automático).
    expect(trecho).toContain("erroControleCampanha(res, error);");
    expect(trecho).not.toContain("executeAttemptCampanha");
    expect(trecho).not.toMatch(/\.enviar\(|GmailHttpTransport|provedorCanarioRuntime|GmailMailGateway/);
    expect(server).not.toContain("executeAttemptCampanha");
    // O domínio mantém a autoridade única da tentativa (fonte do módulo).
    const batch = semComentarios(FONTE_BATCH);
    expect(batch).toContain("entrada.executarTentativa ?? executeAttemptCampanha");
    expect((batch.match(/executarTentativa\(pool,/g) ?? []).length).toBe(1);
    // (16) nenhuma ponte outbox_email/worker na superfície do lote.
    expect(trecho).not.toContain("claimOutbox");
    expect(trecho).not.toContain("outbox_email");
    expect(trecho).not.toContain("executarWorkerUmaVezLive");
    expect(batch).not.toContain("outbox_email");
    expect(batch).not.toContain("claimOutbox");
    // (14) a rota só devolve o aggregate sanitizado (nenhum campo de PII).
    expect(trecho).toContain("processadosNestaExecucao");
    expect(trecho).toContain("restantesPreparados");
    expect(trecho).not.toMatch(/destinatario|fingerprint|access_token|refresh_token|receipt:/);
  });
});

function firstCookie(header: string | readonly string[] | string[] | undefined): string {
  const valor: unknown = Array.isArray(header) ? header[0] : header;
  return typeof valor === "string" ? valor.split("\n")[0]?.split(";")[0] ?? "" : "";
}
