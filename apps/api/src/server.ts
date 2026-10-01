import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createHmac,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  NodePostgresPool,
  PostgresOperationalRepository,
  PostgresConfirmationOwnership,
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  PostgresOperatorIdentityRepository,
  OperatorAdminAuthorizationError,
  OperatorAdminContinuityError,
  type OperatorIdentity,
  type OperatorRole,
} from "@integra-correios/persistence";
import {
  analisarXlsx,
  confirmarImportacao,
  executarPreflight,
  type PreflightInput,
} from "./intake.js";
import {
  BloqueioExecucaoControladaError,
  CODIGO_LOTE_HISTORICO_DRY_RUN,
  ativarLoteControlado,
  autorizarRecuperacaoOauthGate,
  autorizarRetryPreRede,
  executarWorkerControladoUmaVez,
  mapearFalhaExecucao,
  registrarFalhaExecucao,
  validarCancelamentoLoteHistorico,
} from "./pilot.js";
import {
  BloqueioLoteControladoError,
  carregarPilotPolicy,
  carregarPoliticaControlada,
  carregarPoliticaProvider,
  CODIGO_LOTE_TESTE_CONTROLADO,
  gerarPreviewComunicacao,
  lerEstadoLoteControlado,
  listarProfissionais,
  prepararLotePiloto,
  prepararLoteTesteControlado,
  recuperarLotePilotoEmAndamento,
  statusOutbox,
  LotePilotoEmAndamentoError,
  type FiltroCockpit,
} from "./pilot.js";
import {
  iniciarFluxoOauth,
  concluirFluxoOauth,
  contaGmailEsperada,
  hdOrganizacionalEsperado,
  hashOperadorGmail,
  OauthFlowError,
  oauthConfigurado,
} from "./oauth.js";
import {
  concluirConfirmacao,
  validarDadosPropostos,
  ConfirmationInvalidaError,
  type ConfirmationDecisionInput,
} from "./confirmation.js";
import {
  acoesCampanhaPorPapeis,
  baseSinteticaCampanha,
  CampaignTemplateSelectionError,
  carregarPoliticaCampanhaAtualizacao,
  campanhasSelecionaveisCampanha,
  contentHashDoTemplateSelecionado,
  metadadosTemplateCampanha,
  normalizarCampoExibicaoCampanha,
  normalizarExibicaoRegistroCampanha,
  selecionarTemplateCampanhaNova,
  hashAprovacaoCampanha,
  snapshotCampanha,
  CAMPANHA_APROVACAO_V2,
} from "./campaigns.js";
import {
  AvaliacaoInvalidaError,
  avaliarArquivoCampanha,
  avaliarBaseCampanha,
} from "./campaign-import.js";
import {
  CampaignControlError,
  avaliarAcaoOperacaoCampanha,
  ativarLoteCampanha,
  lerEstoqueOperacionalCampanha,
  prepararLoteCampanha,
  autorizarExecucaoCampanha,
} from "./campaign-control.js";
// SLICE-03C.2A — fundação runtime do canário (preflight ZERO CLAIM,
// provider Gmail, OAuth readiness read-only). STRICT NO SEND: o caminho só
// arma com PF_CAMPAIGN_CANARY_SEND_ENABLED=true (política) e a UI não tem
// handler de envio.
import { criarCampanhaGmailRuntime } from "./campaign-gmail-runtime.js";
// GF5.2 — preflight READ-ONLY do lote controlado (EXECUTAR_LOTE no readiness).
import { preflightLoteCampanha } from "./campaign-batch.js";
import {
  ProvedorGmailCampanha,
  avaliarReadinessOauthCanario,
  enviarCanarioCampanha,
  preflightCanarioCampanha,
  statusOauthFromReadiness,
} from "./campaign-canary.js";
import type { ProvedorEnvioCampanha } from "./campaign-execution.js";
//
// SLICE-03C.2A.1 (Seção C) — INJEÇÃO DE PROVIDER EXCLUSIVA PARA TESTE:
// dependency injection de fábrica, NUNCA selecionável por request (query/
// body/header/cookie), NUNCA por variável operacional genérica, NUNCA por
// NODE_ENV. O runtime normal SEMPRE constrói o provider Gmail real (com
// transport/token não configurados nesta fatia ⇒ FALHA_PRE_PROVIDER).
// TEST_PROVIDER_DEPENDENCY_INJECTION=true.
let provedorCanarioParaTeste: ProvedorEnvioCampanha | null = null;
export function injetarProvedorCanarioParaTeste(
  provider: ProvedorEnvioCampanha | null,
): void {
  provedorCanarioParaTeste = provider;
}

function provedorCanarioRuntime(campanhaId: string): ProvedorEnvioCampanha {
  // SLICE-03C.2B1A — provider fake permanece disponível SOMENTE por DI de teste.
  if (provedorCanarioParaTeste) return provedorCanarioParaTeste;
  // Runtime Gmail REAL: transport + token resolver (decrypt/refresh/
  // persistência cifrada) compostos no GmailMailGateway. O envio continua
  // fail-closed pelas políticas de produção (flags ausentes ou false).
  const runtime = criarCampanhaGmailRuntime({ env: process.env, pool: requireDbPool() });
  return new ProvedorGmailCampanha({
    pool: requireDbPool(),
    campanhaId,
    gateway: new GmailMailGateway(runtime.transport, runtime.loadAccessToken, undefined, process.env),
  });
}

import {
  CampaignPersistenceError,
  lerRegistroCampanhaParaPreview,
  listarCampanhasRetomaveis,
  recuperarCampanhaPorId,
  recuperarEstadoCampanha,
  persistirCampanhaAprovada,
  persistirLoteCampanha,
  type CampaignPersistDecisao,
  type CampaignPersistRegistro,
} from "./campaign-persistence.js";
import { createWebTokenService } from "@integra-correios/pf-workflow";
import {
  MapeamentoInvalidoError,
  PfUpdateCampaignImportError,
} from "@integra-correios/importers";
import {
  loadGmailOauthConfig,
  metadadosTemplate as metadadosTemplateNoRegistry,
  renderizarTemplatePersistido,
  type RenderInputCampanha,
  oauthStatusFromEnvironment,
  OAUTH_BINDING_COOKIE,
  GmailMailGateway,
} from "@integra-correios/mail";
import {
  avaliarReadiness,
  workerPodeExecutar,
  sondarDatabase,
  executarWorkerUmaVez,
  executarWorkerUmaVezLive,
} from "@integra-correios/worker";

/**
 * CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — a execução controlada somente
 * prossegue após evento auditado PF_CONTROLLED_RETRY_AUTORIZADO quando a
 * PRE_CLAIM_500_DIAGNOSIS — a correlação compara o evento com a última
 * mutação FAILED da outbox do teste usando a coluna REAL da mutação
 * (bloqueada_em, gravada por markOutboxFailed). A versão anterior lia
 * outbox_email.atualizada_em — coluna inexistente (42703 undefined column
 * em produção), o que derrubava o POST /execute em HTTP 500 ANTES do claim.
 */
async function retryPreRedeAutorizado(pool: {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
}): Promise<boolean> {
  if (process.env.REAL_SEND_ENABLED !== "true") return false;
  const resultado = await pool.query(
    `SELECT count(*)::int AS total
    FROM evento_auditoria ea
    JOIN lote_comunicacao l ON l.id = ea.agregado_id AND ea.agregado_tipo = 'LOTE_COMUNICACAO'
    WHERE ea.tipo = 'PF_CONTROLLED_RETRY_AUTORIZADO'
      AND l.codigo = $1
      AND ea.ocorreu_em > COALESCE((
        SELECT max(o.bloqueada_em) FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l2 ON l2.id = c.lote_comunicacao_id
        WHERE l2.codigo = $1 AND o.status = 'FAILED'), 'epoch')`,
    [CODIGO_LOTE_TESTE_CONTROLADO],
  );
  return (resultado.rows[0]?.total ?? 0) > 0;
}

const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * F10 — CONTROLE DE ACESSO.
 *
 * ROTAS PUBLICAS (este servidor não faz matching por prefixo — ver F15):
 *   - /api/health: uptime simples, sem PII;
 *   - GET/POST /api/confirmation: capability token na URL (256 bits,
 *     hash-only no banco, consumo atômico);
 *   - GET /api/oauth/gmail/callback: retorno do Google, protegido pelo
 *     binding one-time start↔callback (state assinado + nonce + cookie).
 *
 * OPERATOR_ROUTE — F12: a autenticação operacional aceita (a) a SESSÃO de
 * curta duração criada por POST /api/operator/session (cookie HttpOnly;
 * token bruto NUNCA vai ao browser) e (b) Authorization: Bearer
 * OPERATOR_TOKEN para CLI/admin técnico. Fail-closed: sem o segredo no
 * ambiente, NENHUMA rota operacional responde.
 */

const ROTAS_PUBLICAS = new Set([
  "GET /api/health",
  "GET /api/confirmation", // consulta por token (capability)
  "POST /api/confirmation", // submissão por token (capability)
  "GET /api/oauth/gmail/callback", // retorno do Google (binding one-time)
  "POST /api/operator/session", // F12: valida token UMA vez e emite sessão (fail-closed sem env)
  "GET /api/operator/session", // F17: restore da sessão pela UI (200/401 sanitizado)
  "DELETE /api/operator/session", // logout operacional
  "POST /api/operator/identity/session", // autenticação individual; handler próprio
  "DELETE /api/operator/identity/session", // logout individual; handler próprio
]);

// Rotas da nova interface com autenticação própria. Não passam pelo fallback
// de OPERATOR_TOKEN/sessão compartilhada do piloto.
const ROTAS_AUTH_PROPRIA = new Set([
  "GET /api/operator/me",
  "GET /api/campaigns/status",
  "GET /api/campaigns/synthetic-base",
  "POST /api/campaigns/analyze",
  "POST /api/campaigns/evaluate",
  "POST /api/campaigns/authorize",
  "GET /api/operator/workspace/status",
  "POST /api/operator/admin/provision",
  "POST /api/operator/admin/credentials/rotate",
  "POST /api/operator/admin/credentials/recover",
  "POST /api/operator/admin/suspend",
  "GET /api/operator/admin/operators",
  // GF-3 CORRECTIVE-02 (F1) — mapa reconciliado com as rotas REGISTRADAS
  // (inventário `metodo`+`caminhoExato` deste arquivo): a fantasma
  // `GET /api/campaigns/templates` foi removida (nunca registrada) e as
  // rotas reais do catálogo/prévias foram incluídas. Nenhuma rota de
  // campanha fica pública: a chave correta é condição NECESSÁRIA para o
  // handler ser alcançado sem OPERATOR_TOKEN, e o handler SEMPRE exige
  // sessão individual + papel (exigirOperadorCampanha).
  "GET /api/campaigns/template-selecionaveis",
  "GET /api/campaigns/preview-registro",
  "POST /api/campaigns/template-preview",
  "GET /api/campaigns/persisted",
  "GET /api/campaigns/batch",
  "GET /api/campaigns/resumable",
  "GET /api/campaigns/detail",
  "POST /api/campaigns/persist",
  "POST /api/campaigns/batch",
  "GET /api/campaigns/operational-readiness",
  "POST /api/campaigns/prepare",
  "POST /api/campaigns/authorize-execution",
  "POST /api/campaigns/activate",
  "POST /api/campaigns/canary-send",
  "POST /api/campaigns/execute-attempt",
]);


const OPERATOR_SESSION_COOKIE = "ic_operator_session";
const CAMPAIGN_OPERATOR_SESSION_COOKIE = "__Host-ic_campaign_operator_session";
const CAMPAIGN_OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CAMPAIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CAMPAIGN_WORKSPACE_ROLES: readonly OperatorRole[] = [
  "PREPARADOR",
  "REVISOR",
  "APROVADOR",
  "EXECUTOR",
  "SUPERVISOR",
];

/**
 * SLICE-02 — Papéis que autorizam o fluxo persistente de campanha.
 * ADMIN_TECNICO administra identidade, NÃO campanha (sem poder implícito).
 */
const CAMPAIGN_OPERATIONAL_ROLES: readonly OperatorRole[] = [
  "PREPARADOR",
  "REVISOR",
  "APROVADOR",
  "EXECUTOR",
  "SUPERVISOR",
];

/**
 * GF-3 CORRECTIVE-01 (F1) — autoridade do canário REAL: somente EXECUTOR
 * autoriza `POST /api/campaigns/canary-send` ANTES de qualquer preflight,
 * claim, resolução de token, provider ou Gmail. Reutiliza o contrato existente
 * de `exigirOperadorCampanha` (403 OPERATOR_ROLE_FORBIDDEN) — nenhum segundo
 * framework de autorização.
 */
const CAMPAIGN_EXECUTOR_ROLES: readonly OperatorRole[] = ["EXECUTOR"];

/**
 * GF-3 CORRECTIVE-02 (F2) — papéis de LEITURA do catálogo de templates
 * (GET /api/campaigns/template-selecionaveis). PREPARADOR monta a base e
 * seleciona a versão; APROVADOR audita o que aprova; REVISOR participa da
 * revisão de conteúdo (PF_CAMPAIGN_ROLE_ACTIONS.REVISOR =
 * RESOLVER_INCONSISTENCIAS). EXECUTOR e ADMIN_TECNICO ficam de fora:
 * nenhum contrato existente os vincula à seleção/revisão de template.
 */
const CAMPANHA_CATALOGO_ROLES: readonly OperatorRole[] = [
  "PREPARADOR",
  "REVISOR",
  "APROVADOR",
];

/** Pool do banco operacional (mesma fonte do requireDb, sem repository). */
function requireDbPool(): NodePostgresPool {
  return requireDb().pool;
}

/** Validação server-side da submissão de aprovação (mesma regra do authorize). */
function validarSubmissaoAprovacao(corpo: unknown): {
  registros: CampaignPersistRegistro[];
  templateVersao: string;
} | undefined {
  const entrada = corpo as {
    templateVersao?: unknown;
    registros?: unknown;
  };
  // GF-2 F5 — SEM default de template: versão ausente/vazia ⇒ submissão
  // inválida (422). A versão deve corresponder EXATAMENTE a uma entrada
  // selecionável do registry (validado no authorize/persist abaixo).
  const templateVersao =
    typeof entrada.templateVersao === "string" && entrada.templateVersao.trim() !== ""
      ? entrada.templateVersao.trim()
      : "";
  const registros = Array.isArray(entrada.registros) ? entrada.registros : [];
  if (templateVersao.length > 80 || registros.length === 0 || registros.length > 20_000) {
    return undefined;
  }
  // GF-2 FINAL — validação estrutural de cada registro + normalização dos
  // campos de exibição (PREFILLED_CONFIRMATION): confinados ao formato de
  // apresentação (whitespace sequencial → espaço único; trim; vazio ⇒
  // ausente); caractere de controle ⇒ submissão inválida (422 sanitizado).
  // Nenhum campo de CPF é aceito neste contrato; identidade permanece opaca
  // (profissional_id é UUID server-side, NUNCA CPF).
  const normalizados: CampaignPersistRegistro[] = [];
  for (const registroBruto of registros) {
    const registro = registroBruto as {
      profissional_id?: unknown;
      nome?: unknown;
      email_normalizado?: unknown;
      status_validacao?: unknown;
      exibicao?: unknown;
      source_record_key?: unknown;
    };
    if (
      typeof registro !== "object" ||
      registro === null ||
      typeof registro.profissional_id !== "string" ||
      registro.profissional_id.trim() === "" ||
      typeof registro.nome !== "string" ||
      registro.nome.trim() === "" ||
      typeof registro.email_normalizado !== "string" ||
      registro.email_normalizado.trim() === "" ||
      registro.status_validacao !== "APTO"
    ) {
      return undefined;
    }
    let exibicao: ReturnType<typeof normalizarExibicaoRegistroCampanha>;
    try {
      exibicao = normalizarExibicaoRegistroCampanha(registro.exibicao);
    } catch {
      return undefined;
    }
    // GF-2 CORRETIVO — proveniência opaca da fonte: presente, deve ser a
    // chave SHA-256 derivada SERVER-SIDE (o browser apenas a ecoa). Ausente
    // permanece válido (contratos herdados); valor inválido ⇒ 422.
    let sourceRecordKey: string | undefined;
    if (registro.source_record_key !== undefined && registro.source_record_key !== null) {
      if (
        typeof registro.source_record_key !== "string" ||
        !/^[0-9a-f]{64}$/.test(registro.source_record_key.trim().toLowerCase())
      ) {
        return undefined;
      }
      sourceRecordKey = registro.source_record_key.trim().toLowerCase();
    }
    normalizados.push(
      exibicao === undefined
        ? {
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
            ...(sourceRecordKey === undefined ? {} : { source_record_key: sourceRecordKey }),
          }
        : {
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
            ...(sourceRecordKey === undefined ? {} : { source_record_key: sourceRecordKey }),
            exibicao,
          },
    );
  }
  return { registros: normalizados, templateVersao };
}

/** Decisões humanas estruturadas (coerentes com as linhas dos registros). */
function validarDecisoesHumanas(corpo: unknown): CampaignPersistDecisao[] | undefined {
  const entrada = corpo as { decisoes?: unknown };
  if (entrada.decisoes === undefined) return [];
  if (!Array.isArray(entrada.decisoes) || entrada.decisoes.length > 20_000) return undefined;
  const decisoes: CampaignPersistDecisao[] = [];
  for (const item of entrada.decisoes) {
    const candidata = item as {
      linha?: unknown;
      profissional_id?: unknown;
      tipo?: unknown;
      motivo?: unknown;
    };
    if (
      typeof item !== "object" ||
      item === null ||
      !Number.isSafeInteger(candidata.linha) ||
      (candidata.linha as number) < 1 ||
      typeof candidata.profissional_id !== "string" ||
      candidata.profissional_id.trim() === "" ||
      (candidata.tipo !== "EXCLUSAO_HUMANA" && candidata.tipo !== "INCONSISTENCIA_JULGADA") ||
      typeof candidata.motivo !== "string" ||
      candidata.motivo.trim() === ""
    ) {
      return undefined;
    }
    const decisao = item as {
      linha: number;
      profissional_id: string;
      tipo: "EXCLUSAO_HUMANA" | "INCONSISTENCIA_JULGADA";
      motivo: string;
    };
    decisoes.push({
      linha: decisao.linha,
      profissional_id: decisao.profissional_id.trim(),
      tipo: decisao.tipo,
      motivo: decisao.motivo.trim().slice(0, 80),
    });
  }
  return decisoes;
}

function erroPersistenciaCampanha(
  res: ServerResponse,
  error: unknown,
): void {
  if (error instanceof CampaignPersistenceError) {
    const status =
      error.code === "CAMPAIGN_INPUT_INVALID" ||
      error.code === "CAMPAIGN_NOT_APPROVED" ||
      error.code === "CAMPAIGN_BATCH_INVALID" ||
      error.code === "CAMPAIGN_EXIBICAO_INVALIDA"
        ? 422
        : error.code === "CAMPAIGN_APPROVAL_STALE"
          ? 409
          : error.code === "CAMPAIGN_PERSISTED_NOT_FOUND"
            ? 404
            : error.code === "CAMPAIGN_OPERATOR_FORBIDDEN"
              ? 403
              : 500;
    json(res, status, { erro: error.message, codigo: error.code });
    return;
  }
  const mensagem = error instanceof Error ? error.message : "Erro interno.";
  json(res, 500, { erro: mensagem.slice(0, 200) });
}

/**
 * SLICE-03B — mapeamento de erro do plano de controle: bloqueio de domínio
 * → 409 sanitizado; infraestrutura → 503; entrada inválida → 422. Nenhum
 * detalhe interno, HMAC ou PII na resposta.
 */
function erroControleCampanha(res: ServerResponse, error: unknown): void {
  if (error instanceof CampaignControlError) {
    const status = error.code === "CAMPAIGN_INPUT_INVALID" ? 422 : 409;
    json(res, status, { erro: error.message, codigo: error.code });
    return;
  }
  erroPersistenciaCampanha(res, error);
}

/** F12 — TTL da sessão operacional (cookie HttpOnly; token NUNCA vai ao browser). */
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** F13/F18 — TTL curto do binding one-time do fluxo OAuth. */
const OAUTH_BINDING_TTL_SECONDS = 600;
/** F16 — versão do formato do cookie de sessão stateless (rotação de formato). */
const OPERATOR_SESSION_VERSION = "v1";

/**
 * F16 — Sessão operacional STATELESS assinada (serverless-safe).
 *
 * O cookie carrega `version.issuedAt.expiresAt.nonce.signature` (HMAC-SHA256);
 * a chave de assinatura é DERIVADA do OPERATOR_TOKEN via HKDF com domain
 * separation — nenhum secret externo novo, e o OPERATOR_TOKEN JAMAIS vai ao
 * cookie. Rotação do token invalida todas as sessões anteriores (a chave
 * derivada muda). Validação server-side: formato, assinatura (timing-safe),
 * expiração. Nenhuma memória de processo, nenhuma afinidade de instância.
 */
function chaveSessaoOperador(): Buffer {
  const token = process.env.OPERATOR_TOKEN?.trim();
  if (!token) {
    throw new Error("OPERATOR_TOKEN ausente — chave de sessão não derivável.");
  }
  // HKDF-SHA256, domain separation explícita (info), salt fixo da aplicação.
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(token, "utf8"),
      Buffer.from("integra-correios:operator-session:v1", "utf8"),
      Buffer.from("ic_operator_session_cookie_signature", "utf8"),
      32,
    ),
  );
}

function assinarSessao(payload: string): string {
  return createHmac("sha256", chaveSessaoOperador()).update(payload).digest("base64url");
}

function comparacaoTimingSafeString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Emite o cookie de sessão stateless assinado (apenas POST bem-sucedido). */
function criarSessaoOperador(): { cookie: string; expiraEm: number } {
  const agora = Date.now();
  const expiraEm = agora + OPERATOR_SESSION_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${OPERATOR_SESSION_VERSION}.${agora}.${expiraEm}.${nonce}`;
  const assinatura = assinarSessao(payload);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    cookie: `${OPERATOR_SESSION_COOKIE}=${payload}.${assinatura}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.floor(OPERATOR_SESSION_TTL_MS / 1000)}`,
    expiraEm,
  };
}

/**
 * F16 — Valida o cookie de sessão stateless: formato versionado, assinatura
 * HMAC (timing-safe) e expiração server-side. Qualquer divergência → inválida.
 */
function sessaoOperadorValida(valorCookie: string | undefined, agora: number = Date.now()): boolean {
  if (!valorCookie?.trim()) return false;
  const partes = valorCookie.trim().split(".");
  if (partes.length !== 5) return false;
  const [versao, issuedAt, expiresAt, nonce, assinatura] = partes as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (versao !== OPERATOR_SESSION_VERSION) return false;
  const payload = `${versao}.${issuedAt}.${expiresAt}.${nonce}`;
  // Assinatura verificada ANTES de qualquer parse numérico (timing-safe).
  if (!comparacaoTimingSafeString(assinatura, assinarSessao(payload))) return false;
  const expira = Number(expiresAt);
  if (!Number.isSafeInteger(expira) || expira <= agora) return false;
  return true;
}

/** Expiração (ISO) embutida no cookie de sessão válido — nunca o token. */
function expiracaoDaSessao(valorCookie: string | undefined): string | undefined {
  if (!valorCookie?.trim()) return undefined;
  const partes = valorCookie.trim().split(".");
  if (partes.length !== 5) return undefined;
  const expira = Number(partes[2]);
  return Number.isSafeInteger(expira) ? new Date(expira).toISOString() : undefined;
}

/** Comparação em tempo constante (buffers de igual comprimento). */
function timingSafeIgual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function caixa(): Aes256GcmSecretBox {
  return new Aes256GcmSecretBox(
    Buffer.from(process.env.DATA_ENCRYPTION_KEY_BASE64 ?? "", "base64"),
    process.env.DATA_ENCRYPTION_KEY_VERSION ?? "v1",
  );
}

function fingerprinter(): HmacSha256Fingerprinter {
  return new HmacSha256Fingerprinter(
    Buffer.from(process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 ?? "", "base64"),
  );
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/** Limite de tamanho do header x-mapping (JSON do mapeamento UI→API). */
const MAX_MAPPING_BYTES = 64 * 1024;
/** Limite de tamanho do header x-file-name decodificado. */
const MAX_FILE_NAME_BYTES = 512;

export class ContratoInvalidoError extends Error {
  constructor(readonly codigo: string, message: string) {
    super(message);
    this.name = "ContratoInvalidoError";
  }
}

/**
 * Contrato browser→API do mapeamento (F13 do browser/API):
 *   UI envia  encodeURIComponent(JSON.stringify(mapping))
 *   API decodifica  decodeURIComponent → JSON.parse → validação de schema.
 * Payload malformado/grande demais → erro 400 sanitizado (nunca 500).
 */
export function parseMappingHeader(bruto: string | undefined): { campo: string; coluna: number }[] {
  if (!bruto?.trim()) {
    throw new ContratoInvalidoError("MAPPING_MISSING", "Header x-mapping ausente.");
  }
  if (bruto.length > MAX_MAPPING_BYTES) {
    throw new ContratoInvalidoError("MAPPING_TOO_LARGE", "Header x-mapping excede o limite de tamanho.");
  }
  let decodificado: string;
  try {
    decodificado = decodeURIComponent(bruto);
  } catch {
    throw new ContratoInvalidoError("MAPPING_MALFORMED", "Header x-mapping não é uma codificação de componente válida.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodificado);
  } catch {
    throw new ContratoInvalidoError("MAPPING_MALFORMED", "Header x-mapping não contém JSON válido.");
  }
  if (!Array.isArray(parsed)) {
    throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Header x-mapping deve ser um array de { campo, coluna }.");
  }
  const itens: { campo: string; coluna: number }[] = [];
  for (const entrada of parsed) {
    if (typeof entrada !== "object" || entrada === null) {
      throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Item do mapeamento deve ser objeto.");
    }
    const { campo, coluna } = entrada as { campo?: unknown; coluna?: unknown };
    if (typeof campo !== "string" || !campo.trim() || campo.length > 64) {
      throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Campo do mapeamento inválido.");
    }
    if (typeof coluna !== "number" || !Number.isInteger(coluna) || coluna < 0 || coluna > 1023) {
      throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Coluna do mapeamento inválida.");
    }
    itens.push({ campo: campo.trim(), coluna });
  }
  return itens;
}

/**
 * Contrato simétrico do x-file-name: encode no browser → decode seguro aqui.
 * Nome ausente demais/inválido → erro 400 sanitizado (nunca 500).
 */
export function parseFileNameHeader(bruto: string | undefined): string {
  const cru = bruto?.trim() ?? "";
  if (!cru) return "entrada.xlsx";
  if (cru.length > MAX_FILE_NAME_BYTES * 4) {
    throw new ContratoInvalidoError("FILE_NAME_TOO_LARGE", "Nome de arquivo excede o limite.");
  }
  let decodificado: string;
  try {
    decodificado = decodeURIComponent(cru);
  } catch {
    throw new ContratoInvalidoError("FILE_NAME_MALFORMED", "Nome de arquivo com codificação inválida.");
  }
  if (!decodificado || decodificado.length > MAX_FILE_NAME_BYTES) {
    throw new ContratoInvalidoError("FILE_NAME_INVALID", "Nome de arquivo vazio ou excessivo.");
  }
  // Nome nunca é usado em paths/commands — apenas exibição/metadado.
  if (/[\r\n\u0000]/.test(decodificado)) {
    throw new ContratoInvalidoError("FILE_NAME_INVALID", "Nome de arquivo contém caracteres proibidos.");
  }
  return decodificado;
}

/**
 * Header x-mapping da campanha (opcional): JSON { campo: coluna }.
 * Formato inválido, campo vazio/excessivo ou coluna fora de 0..1023 →
 * erro 400 sanitizado (nunca 500).
 */
export function parseCampaignMappingHeader(
  bruto: string | undefined,
): Record<string, number> | undefined {
  const cru = bruto?.trim();
  if (!cru) return undefined;
  if (cru.length > 4096) {
    throw new ContratoInvalidoError("MAPPING_TOO_LARGE", "Header x-mapping excede o limite de tamanho.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cru);
  } catch {
    throw new ContratoInvalidoError("MAPPING_MALFORMED", "Header x-mapping não contém JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContratoInvalidoError(
      "MAPPING_INVALID_SCHEMA",
      "Header x-mapping deve ser um objeto { campo: coluna }.",
    );
  }
  const mapeamento: Record<string, number> = {};
  for (const [campo, coluna] of Object.entries(parsed as Record<string, unknown>)) {
    if (!campo.trim() || campo.length > 64) {
      throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Campo do mapeamento inválido.");
    }
    if (typeof coluna !== "number" || !Number.isInteger(coluna) || coluna < 0 || coluna > 1023) {
      throw new ContratoInvalidoError("MAPPING_INVALID_SCHEMA", "Coluna do mapeamento inválida.");
    }
    mapeamento[campo.trim()] = coluna;
  }
  return mapeamento;
}

async function lerCorpo(req: IncomingMessage, limite = MAX_UPLOAD_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limite) throw new Error("Payload acima do limite de upload.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface Recursos {
  pool?: NodePostgresPool;
  repository?: PostgresOperationalRepository;
}

const recursos: Recursos = {};

function requireDb(): { pool: NodePostgresPool; repository: PostgresOperationalRepository } {
  if (!recursos.pool) {
    recursos.pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL });
    recursos.repository = new PostgresOperationalRepository(recursos.pool);
  }
  return { pool: recursos.pool, repository: recursos.repository! };
}

type RotaHandler = (req: IncomingMessage, res: ServerResponse, url: URL, corpo: Buffer) => Promise<void>;

/**
 * F15 — Rota com matching EXATO (estáticas) ou matcher explícito (dinâmicas).
 * Nenhuma rota futura herda autoridade/público por compartilhar prefixo:
 * `startsWith` foi eliminado do roteamento e da autorização.
 */
interface Rota {
  metodo: string;
  caminhoExato?: string;
  /** Matcher restrito para rotas dinâmicas — prefixo nunca é suficiente. */
  matcher?: (pathname: string) => boolean;
  handler: RotaHandler;
}

function sessaoCookieRemovido(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OPERATOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

/** Cookie HttpOnly do binding OAuth (F13) com expiração explícita. */
function bindingCookie(valor: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OAUTH_BINDING_COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${OAUTH_BINDING_TTL_SECONDS}`;
}

/** Exclui o cookie de binding após o consumo/conclusão do fluxo. */
function bindingCookieRemovido(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OAUTH_BINDING_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

function cookiesDo(req: IncomingMessage): Record<string, string> {
  const bruto = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};
  for (const parte of bruto.split(";")) {
    const idx = parte.indexOf("=");
    if (idx > 0) cookies[parte.slice(0, idx).trim()] = parte.slice(idx + 1).trim();
  }
  return cookies;
}

function hashSegredoOpaco(valor: string): string {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

function cookieSessaoCampanha(valor: string, maxAgeSeconds: number): string {
  return `${CAMPAIGN_OPERATOR_SESSION_COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function cookieSessaoCampanhaRemovido(): string {
  return `${CAMPAIGN_OPERATOR_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function tokenIndividualValido(token: string): boolean {
  return CAMPAIGN_TOKEN_PATTERN.test(token);
}

function credentialHashValido(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function operatorUuidValido(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function textoOperadorValido(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength;
}

function expiracaoTokenValida(value: unknown, now: Date): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.trim() === "") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch > now.getTime();
}

function operatorIdentityRepository(): PostgresOperatorIdentityRepository {
  return new PostgresOperatorIdentityRepository(requireDb().pool);
}

async function resolverOperadorCampanha(
  req: IncomingMessage,
): Promise<OperatorIdentity | undefined> {
  const rawSession = cookiesDo(req)[CAMPAIGN_OPERATOR_SESSION_COOKIE];
  if (!rawSession || !CAMPAIGN_TOKEN_PATTERN.test(rawSession)) return undefined;
  return operatorIdentityRepository().resolveSession(
    hashSegredoOpaco(rawSession),
    new Date().toISOString(),
  );
}

async function exigirOperadorCampanha(
  req: IncomingMessage,
  res: ServerResponse,
  allowedRoles?: readonly OperatorRole[],
): Promise<OperatorIdentity | undefined> {
  let identity: OperatorIdentity | undefined;
  try {
    identity = await resolverOperadorCampanha(req);
  } catch {
    json(res, 503, {
      erro: "Identidade operacional indisponível.",
      codigo: "OPERATOR_IDENTITY_UNAVAILABLE",
    });
    return undefined;
  }
  if (!identity) {
    json(res, 401, {
      erro: "Sessão individual ausente, expirada ou revogada.",
      codigo: "INDIVIDUAL_OPERATOR_AUTH_REQUIRED",
    });
    return undefined;
  }
  if (allowedRoles && !identity.roles.some((role) => allowedRoles.includes(role))) {
    json(res, 403, {
      erro: "Papel operacional insuficiente.",
      codigo: "OPERATOR_ROLE_FORBIDDEN",
    });
    return undefined;
  }
  return identity;
}

function autenticacaoDeSessao(req: IncomingMessage): boolean {
  // F16: sessão stateless — nenhuma memória de processo; qualquer instância
  // valida o mesmo cookie assinado.
  return sessaoOperadorValida(cookiesDo(req)[OPERATOR_SESSION_COOKIE]);
}

/** Comparação em tempo constante do token do operador (F10/F12). */
function verificarOperador(req: IncomingMessage): boolean {
  const esperado = process.env.OPERATOR_TOKEN?.trim();
  if (!esperado) return false; // fail-closed: sem segredo no ambiente, sem acesso
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * F12 — Autenticação operacional aceita por SESSÃO (cookie HttpOnly) OU
 * Bearer direto (CLI/admin técnico). Sessão inexistente/expirada → 401.
 */
function exigirOperador(req: IncomingMessage, res: ServerResponse): boolean {
  if (autenticacaoDeSessao(req) || verificarOperador(req)) return true;
  json(res, 401, {
    erro: "Autenticação operacional exigida.",
    codigo: "OPERATOR_AUTH_REQUIRED",
  });
  return false;
}

function hashEvento(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}

/** OAuth Gmail READY = credenciais configuradas + conexão persistida ativa. */
async function oauthGmailPronto(): Promise<boolean> {
  if (!loadGmailOauthConfig(process.env)) return false;
  if (!process.env.DATABASE_URL?.trim() || !process.env.DATA_ENCRYPTION_KEY_BASE64?.trim()) return false;
  try {
    return await requireDb().repository.existeConexaoGmailAtiva();
  } catch {
    return false;
  }
}

const ROTAS: readonly Rota[] = [
  // ------------------------------------------------------------------
  // Health público (uptime simples, sem PII).
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/health",
    handler: async (_req, res) => {
      const policy = carregarPilotPolicy();
      const oauth = loadGmailOauthConfig(process.env)
        ? oauthStatusFromEnvironment(process.env, false)
        : "CONFIGURATION_REQUIRED";
      json(res, 200, {
        status: "ok",
        pilot: policy,
        ppn: { enabled: false },
        gmail: { oauthStatus: oauth, realSendEnabled: policy.realSendEnabled },
      });
    },
  },

  // ------------------------------------------------------------------
  // CAMPANHA PF — identidade INDIVIDUAL obrigatória. Nenhuma destas rotas
  // aceita OPERATOR_TOKEN nem a sessão compartilhada do piloto como fallback.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/operator/identity/session",
    handler: async (_req, res, _url, corpo) => {
      let token = "";
      try {
        const body = JSON.parse(corpo.toString("utf8") || "{}") as { token?: unknown };
        token = typeof body.token === "string" ? body.token.trim() : "";
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      if (!tokenIndividualValido(token)) {
        json(res, 401, {
          erro: "Credencial individual inválida.",
          codigo: "INDIVIDUAL_OPERATOR_AUTH_INVALID",
        });
        return;
      }

      const tokenHash = hashSegredoOpaco(token);
      token = "";
      const sessionSecret = randomBytes(32).toString("base64url");
      const sessionHash = hashSegredoOpaco(sessionSecret);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + CAMPAIGN_OPERATOR_SESSION_TTL_MS);
      try {
        const identity = await operatorIdentityRepository().createSessionFromToken({
          tokenHash,
          sessionHash,
          now: now.toISOString(),
          sessionExpiresAt: expiresAt.toISOString(),
        });
        if (!identity) {
          json(res, 401, {
            erro: "Credencial individual inválida, expirada ou revogada.",
            codigo: "INDIVIDUAL_OPERATOR_AUTH_INVALID",
          });
          return;
        }
        json(
          res,
          200,
          {
            status: "INDIVIDUAL_OPERATOR_SESSION_ACTIVE",
            expiraEm: identity.sessionExpiresAt,
          },
          {
            "set-cookie": cookieSessaoCampanha(
              sessionSecret,
              Math.floor(CAMPAIGN_OPERATOR_SESSION_TTL_MS / 1000),
            ),
          },
        );
      } catch {
        json(res, 503, {
          erro: "Identidade operacional indisponível.",
          codigo: "OPERATOR_IDENTITY_UNAVAILABLE",
        });
      }
    },
  },
  {
    metodo: "DELETE",
    caminhoExato: "/api/operator/identity/session",
    handler: async (req, res) => {
      const sessionSecret = cookiesDo(req)[CAMPAIGN_OPERATOR_SESSION_COOKIE];
      if (!sessionSecret || !CAMPAIGN_TOKEN_PATTERN.test(sessionSecret)) {
        json(res, 401, {
          erro: "Sessão individual ausente ou inválida.",
          codigo: "INDIVIDUAL_OPERATOR_AUTH_REQUIRED",
        });
        return;
      }

      try {
        // Idempotente: false significa que a sessão já não está ATIVA.
        // O cookie local pode e deve ser removido; somente falha de persistência
        // (exceção) impede confirmar o logout.
        await operatorIdentityRepository().revokeSession(
          hashSegredoOpaco(sessionSecret),
          new Date().toISOString(),
        );
      } catch {
        json(res, 503, {
          erro: "Não foi possível confirmar a revogação da sessão.",
          codigo: "OPERATOR_SESSION_REVOCATION_UNCONFIRMED",
        });
        return;
      }

      json(
        res,
        200,
        { status: "INDIVIDUAL_OPERATOR_SESSION_CLOSED" },
        { "set-cookie": cookieSessaoCampanhaRemovido() },
      );
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/operator/me",
    handler: async (req, res) => {
      const identity = await exigirOperadorCampanha(req, res);
      if (!identity) return;
      json(res, 200, {
        operatorId: identity.operatorId,
        code: identity.code,
        displayName: identity.displayName,
        status: identity.status,
        roles: identity.roles,
        sessionExpiresAt: identity.sessionExpiresAt,
      });
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/campaigns/status",
    handler: async (req, res) => {
      const identity = await exigirOperadorCampanha(req, res);
      if (!identity) return;
      json(res, 200, carregarPoliticaCampanhaAtualizacao());
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/operator/workspace/status",
    handler: async (req, res) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_WORKSPACE_ROLES);
      if (!identity) return;
      json(res, 200, {
        campaign: carregarPoliticaCampanhaAtualizacao(),
        operatorIdentity: "INDIVIDUAL_ACTIVE",
        operatorId: identity.operatorId,
        roles: identity.roles,
        availableActions: acoesCampanhaPorPapeis(identity.roles),
        queueAvailable: false,
        nextAction: "WAIT_FOR_CAMPAIGN_PERSISTENCE_GATE",
      });
    },
  },

  // ------------------------------------------------------------------
  // CAMPANHA PF — jornada operacional (etapas 3–5) e validade de
  // aprovação. Somente leitura/avaliação EM MEMÓRIA: nada persiste
  // (canPersistImport=false), nada envia (canExecute=false). As ações
  // futuras de escrita revalidarão papel + estado no servidor, sempre.
  // ------------------------------------------------------------------
  {
    // GF-2 FINAL — catálogo server-driven do registry: somente entradas
    // selecionáveis (status APPROVED, escopo PF_CAMPAIGN). O operador
    // seleciona uma templateVersion registrada; NUNCA há default implícito
    // no cliente e o servidor revalida em authorize/persist/claim.
    metodo: "GET",
    caminhoExato: "/api/campaigns/template-selecionaveis",
    // GF-3 CORRECTIVE-02 (F2) — catálogo é LEITURA do registry (nada
    // seleciona, persiste ou envia): legível pelos papéis de
    // preparação/aprovação/revisão. EXECUTOR e ADMIN_TECNICO continuam
    // EXCLUÍDOS (sem contrato existente que os vincule ao catálogo).
    handler: async (req, res) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPANHA_CATALOGO_ROLES);
      if (!identity) return;
      json(res, 200, { templates: campanhasSelecionaveisCampanha() });
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/campaigns/synthetic-base",
    handler: async (req, res) => {
      const identity = await exigirOperadorCampanha(req, res, ["PREPARADOR"]);
      if (!identity) return;
      json(res, 200, {
        registros: baseSinteticaCampanha(),
        aviso:
          "Base sintética de desenvolvimento da interface — NÃO representa destinatários reais.",
      });
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/campaigns/analyze",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, ["PREPARADOR"]);
      if (!identity) return;
      try {
        const nome = parseFileNameHeader(req.headers["x-file-name"]?.toString());
        json(res, 200, avaliarArquivoCampanha(nome, new Uint8Array(corpo)));
      } catch (error) {
        if (error instanceof ContratoInvalidoError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 422, {
          erro: "Arquivo não pôde ser analisado (formato/estrutura inválida).",
          codigo: "CAMPAIGN_FILE_INVALID",
        });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/campaigns/evaluate",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, ["PREPARADOR"]);
      if (!identity) return;
      try {
        const nome = parseFileNameHeader(req.headers["x-file-name"]?.toString());
        const mapeamento = parseCampaignMappingHeader(req.headers["x-mapping"]?.toString());
        json(res, 200, avaliarBaseCampanha(nome, new Uint8Array(corpo), mapeamento ? { mapeamento } : {}));
      } catch (error) {
        if (error instanceof ContratoInvalidoError || error instanceof AvaliacaoInvalidaError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        if (error instanceof PfUpdateCampaignImportError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 422, {
          erro: "Base não pôde ser avaliada (arquivo/mapeamento inválidos).",
          codigo: "CAMPAIGN_EVALUATE_INVALID",
        });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/campaigns/authorize",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, ["APROVADOR"]);
      if (!identity) return;
      let body: {
        templateVersao?: unknown;
        registros?: unknown;
        conteudoHash?: unknown;
      };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_AUTH_JSON_INVALID" });
        return;
      }
      // GF-3 CORRECTIVE-02 (F3) — autoridade ÚNICA de validação/normalização
      // (a MESMA do persist): validarSubmissaoAprovacao valida estrutura,
      // status "APTO", source_record_key (64-hex lowercase) e normaliza os
      // campos de exibição (vazio ⇒ ausente). O segundo validador próprio do
      // authorize foi REMOVIDO: authorize rejeita EXATAMENTE o que persist
      // rejeita, e o hash de aprovação é calculado sobre os registros
      // NORMALIZADOS — o bruto NUNCA é hasheado.
      const submissao = validarSubmissaoAprovacao(body);
      if (!submissao) {
        json(res, 422, {
          erro: "Dados de aprovação inválidos.",
          codigo: "CAMPAIGN_AUTHORIZE_INVALID",
        });
        return;
      }
      const { registros: submissaoRegistros, templateVersao: templateVersaoSubmissao } = submissao;
      // GF-2 F6 — a autorização SÓ é válida para versão SELECIONÁVEL
      // (registrada, APPROVED, escopo PF_CAMPAIGN): RETIRED/DRAFT/desconhecida
      // ⇒ 422 sanitizado, nada congelado.
      try {
        selecionarTemplateCampanhaNova({ templateVersao: templateVersaoSubmissao });
      } catch (error) {
        if (error instanceof CampaignTemplateSelectionError) {
          json(res, 422, { erro: error.message, codigo: error.code });
          return;
        }
        throw error;
      }
      // GF-2 F4/F6 + GF-2 CORRETIVO — o contentHash canônico (registry) e
      // TODOS os campos PREFILLED entram no hash de aprovação V2: autorização
      // fica vinculada a versão + CONTEÚDO + exibição. Qualquer alteração
      // entre authorize e persist ⇒ 409 CAMPAIGN_APPROVAL_STALE. GF-3
      // CORRECTIVE-02 (F3): hash sobre submissaoRegistros NORMALIZADOS
      // (equivalência lógica bruto↔normalizado ⇒ mesmo hash).
      const templateContentHash = contentHashDoTemplateSelecionado(templateVersaoSubmissao);
      const conteudoHash = hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V2,
        templateVersao: templateVersaoSubmissao,
        templateContentHash,
        registros: submissaoRegistros,
      });
      if (typeof body.conteudoHash === "string" && body.conteudoHash !== conteudoHash) {
        json(res, 409, {
          erro: "Conteúdo divergiu do hash submetido — reprovar e reaprovar.",
          codigo: "CAMPAIGN_APPROVAL_STALE",
        });
        return;
      }
      json(res, 200, {
        status: "CAMPAIGN_APPROVAL_FROZEN",
        approvalHashVersion: CAMPANHA_APROVACAO_V2,
        conteudoHash,
        totalItens: submissaoRegistros.length,
        aprovadaPor: identity.operatorId,
        persistida: false,
        aviso:
          "Aprovação calculada e devolvida para manifestação — NADA foi persistido nesta fase (canPersistImport=false, canCreateBatch=false).",
      });
    },
  },

  // ------------------------------------------------------------------
  // SLICE-02 — PERSISTÊNCIA CONTROLADA (0007). Sessão individual +
  // operador ATIVO + papel operacional + flags server-side + hash
  // recalculado do conteúdo re-submetido. 409 CAMPAIGN_APPROVAL_STALE
  // quando o conteúdo diverge da aprovação submetida. Idempotente.
  // ------------------------------------------------------------------
  {
    // GF-2 FINAL — preview server-side de registro da campanha persistida:
    // o browser envia SOMENTE identificadores autorizados (campanhaId +
    // linha); valores e assunto vêm SEMPRE do snapshot congelado via o MESMO
    // registry/renderer do provider. O request NUNCA fornece nome, telefone,
    // endereço, CEP, subject ou corpo (REQUEST_CANNOT_OVERRIDE_SNAPSHOT=false
    // por construção). ZERO mutações, ZERO token, ZERO rede, ZERO Gmail;
    // no-store (json()) e sem PII nos logs.
    metodo: "GET",
    caminhoExato: "/api/campaigns/preview-registro",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      const campanhaId = url.searchParams.get("campanhaId")?.trim() ?? "";
      const linhaBruta = url.searchParams.get("linha")?.trim() ?? "";
      const linha = Number(linhaBruta);
      if (!operatorUuidValido(campanhaId) || !Number.isInteger(linha) || linha < 1) {
        json(res, 422, {
          erro: "campanhaId (UUID) e linha (inteiro ≥ 1) são obrigatórios.",
          codigo: "CAMPAIGN_PREVIEW_INVALID",
        });
        return;
      }
      const pool = requireDbPool();
      try {
        const resultado = await lerRegistroCampanhaParaPreview(pool, {
          operatorId: identity.operatorId,
          campanhaId,
          linha,
        });
        if (!resultado.ok) {
          json(res, resultado.httpStatus, { erro: resultado.erro, codigo: resultado.codigo });
          return;
        }
        json(res, 200, resultado.corpo);
      } catch (error) {
        if (error instanceof CampaignTemplateSelectionError) {
          json(res, 422, { erro: error.message, codigo: error.code });
          return;
        }
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    // GF-3 CORRECTIVE-02 (F7) — PRÉVIA PRÉ-APROVAÇÃO renderizada no SERVIDOR:
    // o request fornece SOMENTE o payload pendente já aceito pelo authorize
    // (templateVersao + registros) e o índice da prévia. O servidor revalida
    // com a MESMA autoridade do authorize/persist (validarSubmissaoAprovacao
    // → registros NORMALIZADOS), confere bounds do índice, resolve o template
    // no REGISTRY e renderiza o registro selecionado com EXATAMENTE o
    // renderer do provider (renderizarTemplatePersistido — identidade
    // sintética de preview; NUNCA assunto/texto/HTML/remetente/Reply-To do
    // browser). ZERO persistência, ZERO mutação, ZERO rede, ZERO log de PII;
    // resposta no-store. O preview PÓS-persistência (GET
    // /api/campaigns/preview-registro, snapshot congelado) permanece separado.
    metodo: "POST",
    caminhoExato: "/api/campaigns/template-preview",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPANHA_CATALOGO_ROLES);
      if (!identity) return;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_TEMPLATE_PREVIEW_JSON_INVALID" });
        return;
      }
      // (1)/(2) MESMA autoridade do authorize/persist → registros NORMALIZADOS.
      const submissao = validarSubmissaoAprovacao(body);
      if (!submissao) {
        json(res, 422, {
          erro: "Dados de prévia inválidos.",
          codigo: "CAMPAIGN_TEMPLATE_PREVIEW_INVALID",
        });
        return;
      }
      // (3) bounds-check do índice solicitado (1-based; navegação da UI).
      const previaIndiceSolicitado: unknown = body.previaIndice;
      if (
        typeof previaIndiceSolicitado !== "number" ||
        !Number.isInteger(previaIndiceSolicitado) ||
        previaIndiceSolicitado < 1 ||
        previaIndiceSolicitado > submissao.registros.length
      ) {
        json(res, 422, {
          erro: "previaIndice deve ser inteiro entre 1 e o total de registros aptos.",
          codigo: "CAMPAIGN_TEMPLATE_PREVIEW_INDEX_INVALID",
        });
        return;
      }
      // (4) resolução server-side do template NO REGISTRY (nada do request).
      try {
        selecionarTemplateCampanhaNova({ templateVersao: submissao.templateVersao });
      } catch (error) {
        if (error instanceof CampaignTemplateSelectionError) {
          json(res, 422, { erro: error.message, codigo: error.code });
          return;
        }
        throw error;
      }
      const metadados = metadadosTemplateNoRegistry(submissao.templateVersao);
      if (!metadados.ok || metadados.contentHash === undefined) {
        json(res, 422, {
          erro: "Versão do template não registrada.",
          codigo: "CAMPAIGN_TEMPLATE_PREVIEW_TEMPLATE_INVALIDO",
        });
        return;
      }
      // (5) renderização com EXATAMENTE o renderer do provider. Identidade
      // sintética de prévia (campaignId/itemId/professionalId/recipient/
      // correlationCode/remetente server-side) — o padrão de
      // lerRegistroCampanhaParaPreview (GET /api/campaigns/preview-registro).
      const registro = submissao.registros[previaIndiceSolicitado - 1];
      if (!registro) {
        json(res, 422, {
          erro: "Índice de prévia não corresponde a um registro apto.",
          codigo: "CAMPAIGN_TEMPLATE_PREVIEW_INDEX_INVALID",
        });
        return;
      }
      // Remetente institucional server-side (mesma política do preview
      // persistido e do canário); NUNCA fornecido pelo browser.
      const remetente = {
        name:
          normalizarCampoExibicaoCampanha(process.env.CAMPAIGN_SENDER_NAME) ??
          "CRT-BA | Carteiras Profissionais",
        address:
          normalizarCampoExibicaoCampanha(process.env.CAMPAIGN_SENDER_ADDRESS) ??
          "carteiras@crtba.org.br",
      };
      const correlationCode = createHash("sha256")
        .update("PF-CAMP-TEMPLATE-PREVIEW-V1\n")
        .update(`${identity.operatorId}\n${previaIndiceSolicitado}\n`)
        .digest("hex")
        .toUpperCase();
      const renderizado = renderizarTemplatePersistido({
        persistedTemplateVersion: submissao.templateVersao,
        professionalName: registro.nome,
        correlationCode: `PF26${correlationCode.slice(0, 28)}`,
        ...(registro.exibicao === undefined
          ? {}
          : { exibicao: registro.exibicao as RenderInputCampanha["exibicao"] }),
        remetente: { name: remetente.name, address: remetente.address },
        campaignId: "preview",
        itemId: `template-preview:${identity.operatorId}:${previaIndiceSolicitado}`,
        professionalId: "preview",
        recipient: registro.email_normalizado,
        messageTag: "pf-campanha",
      });
      if (!renderizado.ok) {
        json(res, 422, {
          erro: "Versão do template não pôde ser renderizada para prévia.",
          codigo: "CAMPAIGN_TEMPLATE_PREVIEW_TEMPLATE_INVALIDO",
        });
        return;
      }
      // Resposta SANITIZADA e no-store: metadados do registry + mensagem
      // renderizada. Nada persistido, nada mutado, nenhuma rede.
      json(res, 200, {
        templateVersao: submissao.templateVersao,
        templateContentHash: metadados.contentHash,
        dataMode: metadados.dataMode ?? "",
        assunto: metadados.subject ?? "",
        mensagem: {
          subject: renderizado.mensagem.subject,
          textBody: renderizado.mensagem.textBody,
          htmlBody: renderizado.mensagem.htmlBody,
        },
      });
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/campaigns/persist",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      const politica = carregarPoliticaCampanhaAtualizacao();
      if (!politica.canPersistImport) {
        json(res, 403, {
          erro: "Persistência da campanha desabilitada por política.",
          codigo: "CAMPAIGN_PERSIST_DISABLED",
        });
        return;
      }
      if (identity.status !== "ATIVO") {
        json(res, 403, {
          erro: "Operador suspenso não pode persistir campanha.",
          codigo: "OPERATOR_SUSPENDED",
        });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_PERSIST_JSON_INVALID" });
        return;
      }
      const submissao = validarSubmissaoAprovacao(body);
      if (!submissao) {
        json(res, 422, {
          erro: "Dados de persistência inválidos: registros aptos são obrigatórios.",
          codigo: "CAMPAIGN_PERSIST_INVALID",
        });
        return;
      }
      const decisoes = validarDecisoesHumanas(body);
      if (!decisoes) {
        json(res, 422, {
          erro: "Decisões humanas inválidas.",
          codigo: "CAMPAIGN_PERSIST_DECISIONS_INVALID",
        });
        return;
      }
      // GF-2 F6 — persist revalida a versão no registry e recalcula o hash
      // com o MESMO templateContentHash da autorização: versão ou conteúdo
      // divergentes da autorização congelada ⇒ 409/422 sanitizado.
      try {
        selecionarTemplateCampanhaNova({ templateVersao: submissao.templateVersao });
      } catch (error) {
        if (error instanceof CampaignTemplateSelectionError) {
          json(res, 422, { erro: error.message, codigo: error.code });
          return;
        }
        throw error;
      }
      // GF-2 CORRETIVO — o hash recalculado é SEMPRE V2 (mesmo contrato da
      // autorização; campos PREFILLED incluídos). Divergência de campo,
      // versão ou conteúdo ⇒ 409 CAMPAIGN_APPROVAL_STALE.
      const fingerprintHash = hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V2,
        templateVersao: submissao.templateVersao,
        templateContentHash: contentHashDoTemplateSelecionado(submissao.templateVersao),
        registros: submissao.registros,
      });
      const hashSubmetido =
        typeof body.conteudoHash === "string" ? body.conteudoHash.trim().toLowerCase() : "";
      if (hashSubmetido && hashSubmetido !== fingerprintHash) {
        json(res, 409, {
          erro: "Conteúdo divergiu da aprovação congelada — reprovar e reaprovar.",
          codigo: "CAMPAIGN_APPROVAL_STALE",
        });
        return;
      }
      const fingerprintArquivo =
        typeof body.fingerprintArquivo === "string" ? body.fingerprintArquivo.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{64}$/.test(fingerprintArquivo)) {
        json(res, 422, {
          erro: "Fingerprint do arquivo de origem ausente ou inválido.",
          codigo: "CAMPAIGN_PERSIST_INVALID",
        });
        return;
      }
      try {
        const resultado = await persistirCampanhaAprovada(requireDbPool(), {
          operatorId: identity.operatorId,
          fingerprintArquivo,
          registros: submissao.registros,
          decisoes,
          templateVersao: submissao.templateVersao,
        });
        json(res, resultado.resultado === "CRIADA" ? 201 : 200, {
          status: resultado.resultado === "CRIADA" ? "CAMPAIGN_PERSISTED" : "CAMPAIGN_ALREADY_PERSISTED",
          campanhaId: resultado.campanhaId,
          conteudoHash: resultado.hashAprovacao,
          totalItens: submissao.registros.length,
          aprovadaPor: identity.operatorId,
          persistida: true,
          aviso:
            "Campanha persistida com hash recalculado no servidor. Lote e outbox ainda não foram criados (use /api/campaigns/batch).",
        });
      } catch (error) {
        if (error instanceof CampaignTemplateSelectionError) {
          json(res, 422, { erro: error.message, codigo: error.code });
          return;
        }
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/campaigns/persisted",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      if (!carregarPoliticaCampanhaAtualizacao().canPersistImport) {
        json(res, 403, {
          erro: "Persistência da campanha desabilitada por política.",
          codigo: "CAMPAIGN_PERSIST_DISABLED",
        });
        return;
      }
      // Recuperação por hash (jornada pós-reload da UI) OU por fingerprint.
      const hashConsulta = url.searchParams.get("hash")?.trim().toLowerCase() ?? "";
      const fingerprintArquivo = url.searchParams.get("fingerprint")?.trim().toLowerCase() ?? "";
      const hashValido = /^[0-9a-f]{64}$/.test(hashConsulta);
      const fingerprintValido = /^[0-9a-f]{64}$/.test(fingerprintArquivo);
      if (!hashValido && !fingerprintValido) {
        json(res, 422, {
          erro: "Informe hash (SHA-256) e/ou fingerprint (SHA-256) para recuperação.",
          codigo: "CAMPAIGN_PERSIST_INVALID",
        });
        return;
      }
      try {
        const estado = await recuperarEstadoCampanha(requireDbPool(), {
          ...(fingerprintValido ? { fingerprintArquivo } : {}),
          ...(hashValido ? { hashAprovacao: hashConsulta } : {}),
          operatorId: identity.operatorId,
        });
        if (!estado) {
          // Isolamento por operador: campanha de terceiro é indistinguível de
          // inexistente (404 sanitizado, sem revelar existência/proprietário).
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este fingerprint/hash.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        json(res, 200, { campanha: estado });
      } catch (error) {
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    // ------------------------------------------------------------------
    // UX-FLOW-01B — Detalhe READ-ONLY de UMA campanha (seleção explícita da
    // retomada MULTIPLE). campanhaId vem do cliente, porém o escopo é
    // SEMPRE operator_id da sessão: campanha inexistente ou alheia → 404
    // sanitizado (indistinguível). Sem mutação, sem evento de auditoria.
    // ------------------------------------------------------------------
    metodo: "GET",
    caminhoExato: "/api/campaigns/detail",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      const campanhaId = url.searchParams.get("campanhaId")?.trim() ?? "";
      if (!operatorUuidValido(campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_DETAIL_INVALID",
        });
        return;
      }
      try {
        const estado = await recuperarCampanhaPorId(requireDbPool(), {
          campanhaId,
          operatorId: identity.operatorId,
        });
        if (!estado) {
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este identificador.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        json(res, 200, { campanha: estado });
      } catch (error) {
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    // ------------------------------------------------------------------
    // UX-FLOW-01B — Retomada server-driven: lista READ-ONLY das campanhas
    // persistidas do operador da sessão. Escopo exclusivo = operator_id
    // validado no servidor (nenhum parâmetro do cliente seleciona dados;
    // sem hash e sem fingerprint prévios). Zero mutação: nenhuma escrita,
    // nenhum evento de auditoria. Operador suspenso/revogado não passa do
    // exigirOperadorCampanha (sessão resolvida = ATIVO; 401 sanitizado).
    // Campanha alheia nunca aparece: invisível e indistinguível de ausência
    // (lista vazia ≠ informação sobre terceiros). Contrato de cardinalidade
    // (corretivo UX-FLOW-01B): EMPTY/SINGLE/MULTIPLE dependem da contagem
    // TOTAL de campanhas retomáveis do operador (filtro de estados
    // server-side) — NUNCA de paginação/limite controlado pelo cliente; sem
    // parâmetro limite nesta rota (?limite=N → 422 CAMPAIGN_RESUMABLE_INVALID).
    // ------------------------------------------------------------------
    metodo: "GET",
    caminhoExato: "/api/campaigns/resumable",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      // Corretivo UX-FLOW-01B: ?limite=N sai do contrato — a cardinalidade
      // EMPTY/SINGLE/MULTIPLE nunca pode depender de parâmetro do cliente.
      if (url.searchParams.get("limite") !== null) {
        json(res, 422, {
          erro: "Parâmetro limite não é aceito na retomada (cardinalidade é sempre total).",
          codigo: "CAMPAIGN_RESUMABLE_INVALID",
        });
        return;
      }
      try {
        const campanhas = await listarCampanhasRetomaveis(requireDbPool(), {
          operatorId: identity.operatorId,
        });
        // Política obrigatória de retomada: 0 → EMPTY; 1 → SINGLE (sem
        // seleção pelo cliente); 2+ → MULTIPLE (resumos autorizados; NENHUMA
        // escolha implícita de mais recente/último/maior id/primeira linha).
        if (campanhas.length === 1) {
          const unica = campanhas[0]!;
          json(res, 200, {
            mode: "SINGLE",
            campaign: {
              campanhaId: unica.campanhaId,
              estado: unica.estado,
              totalAprovados: unica.totalAprovados,
              loteId: unica.loteId,
              loteCodigo: unica.loteCodigo,
              loteEstado: unica.loteEstado,
              outboxTotal: unica.outboxTotal,
              outboxNaoExecutavel: unica.outboxNaoExecutavel,
              criadaEm: unica.criadaEm,
            },
          });
          return;
        }
        // Cardinalidade da lista COMPLETA (nenhum limite do cliente):
        // 0 → EMPTY; 1 → SINGLE (bloco acima); 2+ → MULTIPLE (sem escolha
        // implícita — o operador seleciona explicitamente via detail).
        json(res, 200, {
          mode: campanhas.length === 0 ? "EMPTY" : "MULTIPLE",
          campaigns: campanhas,
        });
      } catch (error) {
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/campaigns/batch",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      if (!carregarPoliticaCampanhaAtualizacao().canCreateBatch) {
        json(res, 403, {
          erro: "Criação de lote desabilitada por política.",
          codigo: "CAMPAIGN_BATCH_DISABLED",
        });
        return;
      }
      if (!identity.roles.includes("EXECUTOR")) {
        json(res, 403, {
          erro: "Criação de lote exige papel EXECUTOR.",
          codigo: "OPERATOR_ROLE_FORBIDDEN",
        });
        return;
      }
      if (identity.status !== "ATIVO") {
        json(res, 403, {
          erro: "Operador suspenso não pode criar lote.",
          codigo: "OPERATOR_SUSPENDED",
        });
        return;
      }
      let body: { campanhaId?: unknown; conteudoHash?: unknown };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_BATCH_JSON_INVALID" });
        return;
      }
      if (
        !operatorUuidValido(body.campanhaId) ||
        typeof body.conteudoHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.conteudoHash.trim().toLowerCase())
      ) {
        json(res, 422, {
          erro: "campanhaId (UUID) e conteudoHash (SHA-256) são obrigatórios.",
          codigo: "CAMPAIGN_BATCH_INVALID",
        });
        return;
      }
      const campanhaId = body.campanhaId as string;
      const hashSubmetido = body.conteudoHash.trim().toLowerCase();
      try {
        const lote = await persistirLoteCampanha(requireDbPool(), {
          campanhaId,
          operatorId: identity.operatorId,
          hashSubmetido,
        });
        json(res, lote.resultado === "CRIADO" ? 201 : 200, {
          status:
            lote.resultado === "CRIADO"
              ? "CAMPAIGN_BATCH_CREATED"
              : "CAMPAIGN_BATCH_ALREADY_EXISTS",
          campanhaId,
          lote: {
            id: lote.loteCampanhaId,
            codigo: lote.loteCodigo,
            estado: lote.estado,
            totalItens: lote.totalItens,
            outboxTotal: lote.outboxTotal,
            outboxNaoExecutavel: lote.outboxNaoExecutavel,
          },
          executavel: false,
          aviso:
            lote.resultado === "CRIADO"
              ? "Lote criado em HOLD e outbox NÃO capturável pelo worker (canExecute=false). Nenhuma chamada Gmail foi realizada."
              : "Lote já existente — nenhuma duplicação (idempotência). Gmail não foi chamado.",
        });
      } catch (error) {
        erroPersistenciaCampanha(res, error);
      }
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/campaigns/batch",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      if (!carregarPoliticaCampanhaAtualizacao().canCreateBatch) {
        json(res, 403, {
          erro: "Criação de lote desabilitada por política.",
          codigo: "CAMPAIGN_BATCH_DISABLED",
        });
        return;
      }
      const campanhaId = url.searchParams.get("campanhaId")?.trim() ?? "";
      if (!operatorUuidValido(campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_BATCH_INVALID",
        });
        return;
      }
      try {
        const estado = await requireDbPool().query<{
          lote_id: string | null;
          lote_codigo: string | null;
          lote_estado: string | null;
          total_itens: number | null;
          outbox_total: string | null;
          outbox_hold: string | null;
        }>(
          `SELECT lc.id AS lote_id, lc.codigo AS lote_codigo, lc.estado AS lote_estado,
                  lc.total_itens,
                  (SELECT count(*)::text FROM outbox_campanha o WHERE o.lote_campanha_id = lc.id) AS outbox_total,
                  (SELECT count(*)::text FROM outbox_campanha o
                    WHERE o.lote_campanha_id = lc.id AND o.estado IN ('HOLD','PREPARADO')) AS outbox_hold
             FROM lote_campanha lc
            WHERE lc.campanha_id = $1
              AND EXISTS (
                SELECT 1 FROM campanha_persistida c
                 WHERE c.id = lc.campanha_id AND c.operator_id = $2
              )
            LIMIT 1`,
          [campanhaId, identity.operatorId],
        );
        const lote = estado.rows[0];
        if (!lote?.lote_id) {
          // Isolamento por operador: lote inexistente ou de terceiro é
          // indistinguível (404 sanitizado, sem revelar estado/contadores).
          json(res, 404, {
            erro: "Nenhum lote para esta campanha.",
            codigo: "CAMPAIGN_BATCH_NOT_FOUND",
          });
          return;
        }
        json(res, 200, {
          lote: {
            id: lote.lote_id,
            codigo: lote.lote_codigo,
            estado: lote.lote_estado,
            totalItens: lote.total_itens,
            outboxTotal: Number(lote.outbox_total ?? 0),
            outboxNaoExecutavel: Number(lote.outbox_hold ?? 0),
          },
          executavel: false,
        });
      } catch (error) {
        erroPersistenciaCampanha(res, error);
      }
    },
  },

  // ------------------------------------------------------------------
  // SLICE-03B — PLANO DE CONTROLE OPERACIONAL (NO SEND). Quatro rotas
  // mínimas, todas com sessão individual + escopo exclusivo pelo
  // operator_id da sessão. Nenhuma aceita operator_id, estado, prova,
  // fingerprint ou chave idempotente do cliente: provas são emitidas e
  // verificadas server-side; alheio/inexistente é 404 sanitizado; com as
  // flags fechadas toda mutação é recusada ANTES de qualquer escrita e a
  // tentativa de execução é bloqueada ANTES de claim/provider/Gmail.
  // ------------------------------------------------------------------
  {
    // Readiness READ-ONLY: estado, contagens por estado da outbox da
    // campanha, políticas e bloqueios objetivos + próxima ação. Nenhuma
    // mutação, nenhum evento de auditoria.
    metodo: "GET",
    caminhoExato: "/api/campaigns/operational-readiness",
    handler: async (req, res, url) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      const campanhaId = url.searchParams.get("campanhaId")?.trim() ?? "";
      if (!operatorUuidValido(campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_READINESS_INVALID",
        });
        return;
      }
      try {
        const estoque = await lerEstoqueOperacionalCampanha(requireDbPool(), {
          operatorId: identity.operatorId,
          campanhaId,
        });
        if (!estoque) {
          // Isolamento por operador: campanha alheia é indistinguível de
          // inexistente (404 sanitizado).
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este identificador.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        const politica = carregarPoliticaCampanhaAtualizacao();
        const preparacao = avaliarAcaoOperacaoCampanha({
          acao: "PREPARAR_LOTE",
          politica,
          loteEstado: estoque.loteEstado,
          totalItens: estoque.totalItens,
          autorizacaoHumanaConcedida: estoque.autorizacaoHumana.concedida,
        });
        const autorizacao = avaliarAcaoOperacaoCampanha({
          acao: "AUTORIZAR_EXECUCAO",
          politica,
          loteEstado: estoque.loteEstado,
          totalItens: estoque.totalItens,
          autorizacaoHumanaConcedida: estoque.autorizacaoHumana.concedida,
        });
        const execucao = avaliarAcaoOperacaoCampanha({
          acao: "EXECUTAR_ITEM",
          politica,
          loteEstado: estoque.loteEstado,
          totalItens: estoque.totalItens,
          autorizacaoHumanaConcedida: estoque.autorizacaoHumana.concedida,
        });
        // SLICE-03C.1 — elegibilidade da ATIVAÇÃO (sem segredo na resposta):
        // prova exige chave dedicada; canário exige configuração server-side;
        // ativação exige realSendEnabled=false (o envio só se arma no 03C.2).
        const ativacao = avaliarAcaoOperacaoCampanha({
          acao: "ATIVAR_LOTE",
          politica,
          loteEstado: estoque.loteEstado,
          totalItens: estoque.totalItens,
          autorizacaoHumanaConcedida: estoque.autorizacaoHumana.concedida,
          proofKeyReady: estoque.proofKeyReady,
          canaryRecipientConfigured: estoque.canaryRecipientConfigured,
          canarySelecionado: estoque.canarySelected,
          realSendEnabled: politica.realSendEnabled,
        });
        // SLICE-03C.2A — OAuth readiness READ-ONLY (sem rede, sem token,
        // sem refresh): estados sanitizados + semântica CONNECTED restrita a
        // "persistido e conta esperada correspondente".
        const oauth = await avaliarReadinessOauthCanario(requireDbPool(), fingerprinter());
        // SLICE-03C.2A.1 (Seção E) — a rota consome a DERIVAÇÃO CANÔNICA
        // statusOauthFromReadiness (mesma função do gate). Readiness ≠
        // liveness: TOKEN_REFRESHES=0, GOOGLE_NETWORK_CALLS=0, nenhum token
        // descriptografado; CONNECTED não prova token/refresh/reachability/
        // send-as (03C.2B1).
        const oauthEstado = statusOauthFromReadiness(oauth);
        // GF4.5 — a ação de canário exposta ao UI é derivada SERVER-SIDE
        // pelo MESMO preflight canônico do envio real
        // (preflightCanarioCampanha), em modo ESTRITAMENTE READ-ONLY: zero
        // claim, zero outbox, zero evento, zero carga/descriptografia/refresh
        // de token, zero Google/Gmail/provider. A resposta expõe SOMENTE o
        // par sanitizado { permitida, bloqueios } — nenhum destinatário,
        // fingerprint, prova, token ou segredo. O browser NUNCA reconstrói
        // elegibilidade; POST /api/campaigns/canary-send permanece a ÚNICA
        // autoridade de mutação/envio do canário.
        // GF4.5C.1 (FINDING 1) — autoridade de PAPEL incorporada: a rota de
        // envio exige EXECUTOR ANTES do preflight; o readiness representa a
        // MESMA autoridade efetiva. Sem EXECUTOR ⇒ permitida=false com o
        // bloqueio sanitizado OPERATOR_ROLE_FORBIDDEN (o mesmo código da
        // guarda da rota) — nenhuma configuração interna de papéis é
        // exposta. Invariante: não-EXECUTOR ⇒ readiness false ⇒ botão
        // desabilitado ⇒ e o POST continua rejeitando independentemente.
        const executorHabilitado = identity.roles.includes("EXECUTOR");
        const canarioPreflight = await preflightCanarioCampanha(requireDbPool(), {
          operatorId: identity.operatorId,
          campanhaId,
          politica,
          contexto: { fingerprinter: fingerprinter() },
        });
        // GF5.2 — EXECUTAR_LOTE: mesma disciplina read-only do canário; a
        // elegibilidade EFETIVA = papel EXECUTOR ∧ preflight do lote
        // (política batchSendEnabled ∧ canExecute ∧ realSendEnabled, lote
        // ATIVO, autorização vigente, canário ENVIADO com evidência durável,
        // sem ENFILEIRADO pendente, sem ambiguidade não resolvida, ≥1
        // PREPARADO). Zero claim/mutação/token/rede na derivação.
        const lotePreflight = await preflightLoteCampanha(requireDbPool(), {
          operatorId: identity.operatorId,
          campanhaId,
          papeis: identity.roles,
          politica,
          contexto: { fingerprinter: fingerprinter() },
        });
        json(res, 200, {
          campanha: { campanhaId, estado: "LOTE_CRIADO" },
          lote: {
            loteCampanhaId: estoque.loteCampanhaId,
            codigo: estoque.loteCodigo,
            estado: estoque.loteEstado,
            totalItens: estoque.totalItens,
            contagemPorEstado: estoque.contagemPorEstado,
          },
          politicas: {
            canPrepareBatch: politica.canPrepareBatch,
            canExecute: politica.canExecute,
            realSendEnabled: politica.realSendEnabled,
            canarySendEnabled: politica.canarySendEnabled,
            // GF5.2A — apenas diagnóstico (DISPLAY ONLY): o browser NUNCA
            // deriva permissão desta flag; a autoridade é acao.EXECUTAR_LOTE.
            batchSendEnabled: politica.batchSendEnabled,
          },
          autorizacaoHumana: {
            concedida: estoque.autorizacaoHumana.concedida,
            referenciaPresente: estoque.autorizacaoHumana.referencia !== null,
          },
          ativacao: {
            proofKeyReady: estoque.proofKeyReady,
            canaryRecipientConfigured: estoque.canaryRecipientConfigured,
            canarySelected: estoque.canarySelected,
            canaryReferencePresent: estoque.canaryReferencePresent,
            providerReady: estoque.providerReady,
          },
          // SLICE-03C.2A — campos sanitizados (nenhum e-mail, fingerprint,
          // token ou segredo). CONNECTED ⇒ somente "persistido + conta
          // esperada correspondente"; NÃO significa token ao vivo testado.
          oauth: {
            configurationReady: oauth.oauthConfigurationReady,
            connectionStored: oauth.oauthConnectionStored,
            expectedAccountConfigured: oauth.oauthExpectedAccountConfigured,
            storedAccountMatchesExpected: oauth.oauthStoredAccountMatchesExpected,
            encryptionConfigurationReady: oauth.oauthEncryptionConfigurationReady,
            executionReady: oauth.executionReady,
            estado: oauthEstado,
            // Readiness é liveness-free: nenhuma prova de token ao vivo.
            tokenRefreshes: 0,
            googleNetworkCalls: 0,
          },
          envioCanario: {
            armado: politica.canarySendEnabled,
            providerWiringReady: estoque.providerReady || oauth.executionReady,
            gateOperacional: "PENDING_OWNER",
          },
          acoes: {
            PREPARAR_LOTE: { permitida: preparacao.permitida, bloqueios: preparacao.bloqueios },
            AUTORIZAR_EXECUCAO: { permitida: autorizacao.permitida, bloqueios: autorizacao.bloqueios },
            ATIVAR_LOTE: { permitida: ativacao.permitida, bloqueios: ativacao.bloqueios },
            EXECUTAR_ITEM: { permitida: execucao.permitida, bloqueios: execucao.bloqueios },
            // GF4.5 — derivação canônica do MESMO preflight do envio real;
            // sem fabricar verde a partir de flags grossas: qualquer
            // inconsistência real aparece como bloqueio sanitizado.
            // GF4.5C.1 (FINDING 1) — elegibilidade EFETIVA = papel EXECUTOR
            // (autoridade da rota de envio, inalterada) ∧ preflight canônico.
            EXECUTAR_CANARIO: {
              permitida: executorHabilitado && canarioPreflight.elegivel,
              bloqueios: executorHabilitado
                ? canarioPreflight.elegivel
                  ? []
                  : canarioPreflight.bloqueios
                : ["OPERATOR_ROLE_FORBIDDEN"],
            },
            // GF5.2 — autoridade server-side; o browser NUNCA deriva a
            // elegibilidade do lote localmente.
            EXECUTAR_LOTE: {
              permitida: lotePreflight.elegivel,
              bloqueios: lotePreflight.elegivel ? [] : lotePreflight.bloqueios,
            },
          },
          executavel: false,
          envioRealDesabilitado: !politica.realSendEnabled,
          // GF5.2A — proximaAcao deriva da ELEGIBILIDADE REAL de cada ação
          // (estado + condições), NUNCA de flag acesa isolada: um canário
          // flag-armado que já foi adjudicado NÃO mascara o lote elegível.
          proximaAcao: preparacao.permitida
            ? "PREPARAR_LOTE"
            : autorizacao.permitida
              ? "AUTORIZAR_EXECUCAO"
              : ativacao.permitida
                ? "ATIVAR_LOTE"
                : lotePreflight.elegivel
                  ? "EXECUTAR_LOTE"
                  : canarioPreflight.elegivel
                    ? "EXECUTAR_CANARIO"
                    : politica.canarySendEnabled
                      ? "CANARY_SEND_BLOQUEADO"
                      : "AGUARDAR_GATES_OPERACIONAIS",
        });
      } catch (error) {
        erroControleCampanha(res, error);
      }
    },
  },
  {
    // Preparação controlada (HOLD → PREPARADO). Exige canPrepareBatch e
    // papel EXECUTOR. NÃO liga o Gmail e NÃO captura item: a outbox
    // PREPARADO continua não capturável (claim exige lote ATIVO — 03A).
    metodo: "POST",
    caminhoExato: "/api/campaigns/prepare",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      if (!carregarPoliticaCampanhaAtualizacao().canPrepareBatch) {
        json(res, 403, {
          erro: "Preparação do lote desabilitada por política.",
          codigo: "CAMPAIGN_PREPARE_DISABLED",
        });
        return;
      }
      if (!identity.roles.includes("EXECUTOR")) {
        json(res, 403, {
          erro: "Preparação exige papel EXECUTOR.",
          codigo: "OPERATOR_ROLE_FORBIDDEN",
        });
        return;
      }
      if (identity.status !== "ATIVO") {
        json(res, 403, {
          erro: "Operador suspenso não pode preparar lote.",
          codigo: "OPERATOR_SUSPENDED",
        });
        return;
      }
      let body: { campanhaId?: unknown };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_PREPARE_JSON_INVALID" });
        return;
      }
      if (!operatorUuidValido(body.campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_PREPARE_INVALID",
        });
        return;
      }
      try {
        const resultado = await prepararLoteCampanha(requireDbPool(), {
          operatorId: identity.operatorId,
          campanhaId: body.campanhaId as string,
          politica: carregarPoliticaCampanhaAtualizacao(),
        });
        if (!resultado) {
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este identificador.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        json(res, resultado.resultado === "PREPARADO" ? 200 : 200, {
          status:
            resultado.resultado === "PREPARADO"
              ? "CAMPAIGN_BATCH_PREPARED"
              : "CAMPAIGN_BATCH_ALREADY_PREPARED",
          campanhaId: resultado.campanhaId,
          lote: {
            loteCampanhaId: resultado.loteCampanhaId,
            codigo: resultado.loteCodigo,
            totalItens: resultado.totalItens,
          },
          executavel: false,
          aviso:
            "Lote PREPARADO permanece não capturável: nenhum envio foi realizado e o Gmail não foi chamado.",
        });
      } catch (error) {
        erroControleCampanha(res, error);
      }
    },
  },
  {
    // AUTORIZAÇÃO HUMANA explícita (lote PREPARADO). Emite a prova auditada
    // server-side (evento append-only); NÃO ativa o lote e NÃO executa nada.
    metodo: "POST",
    caminhoExato: "/api/campaigns/authorize-execution",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      const politica = carregarPoliticaCampanhaAtualizacao();
      if (!politica.canExecute) {
        json(res, 403, {
          erro: "Execução desabilitada por política — autorização humana indisponível.",
          codigo: "CAMPAIGN_EXECUTE_DISABLED",
        });
        return;
      }
      if (!identity.roles.includes("EXECUTOR")) {
        json(res, 403, {
          erro: "Autorização exige papel EXECUTOR.",
          codigo: "OPERATOR_ROLE_FORBIDDEN",
        });
        return;
      }
      if (identity.status !== "ATIVO") {
        json(res, 403, {
          erro: "Operador suspenso não pode autorizar execução.",
          codigo: "OPERATOR_SUSPENDED",
        });
        return;
      }
      let body: { campanhaId?: unknown };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_AUTHORIZE_EXEC_JSON_INVALID" });
        return;
      }
      if (!operatorUuidValido(body.campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_AUTHORIZE_EXEC_INVALID",
        });
        return;
      }
      try {
        const resultado = await autorizarExecucaoCampanha(requireDbPool(), {
          operatorId: identity.operatorId,
          campanhaId: body.campanhaId as string,
          politica,
        });
        if (!resultado) {
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este identificador.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        json(res, 200, {
          status:
            resultado.resultado === "AUTORIZADO"
              ? "CAMPAIGN_EXECUTION_AUTHORIZED"
              : "CAMPAIGN_EXECUTION_ALREADY_AUTHORIZED",
          campanhaId: resultado.campanhaId,
          lote: {
            loteCampanhaId: resultado.loteCampanhaId,
            totalItens: resultado.totalItens,
          },
          referenciaPresente: true,
          executavel: false,
          aviso:
            "Autorização registrada server-side. O lote permanece PREPARADO; nenhuma execução foi iniciada.",
        });
      } catch (error) {
        erroControleCampanha(res, error);
      }
    },
  },
  {
    // SLICE-03C.2A — CANARY SEND (STRICT NO SEND neste gate). Corpo aceita
    // EXCLUSIVAMENTE campanhaId (UUID); itemId/lote/destinatário/fingerprint/
    // provas/flags/provider são reconstruídos SERVER-SIDE (evento persistido
    // + snapshot congelado + política única). Preflight read-only OBRIGATÓRIO
    // antes do claim: qualquer bloqueio ⇒ ZERO claim, ZERO mutação, ZERO
    // evento, ZERO token, ZERO provider, ZERO rede. Resposta sanitizada
    // (sem e-mail, fingerprint, HMAC, token ou segredo).
    metodo: "POST",
    caminhoExato: "/api/campaigns/canary-send",
    handler: async (req, res, _url, corpo) => {
      // GF-3 CORRECTIVE-01 (F1) — papel EXECUTOR exigido ANTES do preflight:
      // PREPARADOR/REVISOR/APROVADOR/SUPERVISOR ⇒ 403 estável com
      // CLAIMS=0, TOKEN_LOADS=0, PROVIDER_CALLS=0, GMAIL_CALLS=0.
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_EXECUTOR_ROLES);
      if (!identity) return;
      let body: { campanhaId?: unknown };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_CANARY_JSON_INVALID" });
        return;
      }
      if (!operatorUuidValido(body.campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_CANARY_INVALID",
        });
        return;
      }
      const recebidas = Object.keys((body as Record<string, unknown>)).filter((k) => k !== "campanhaId");
      if (recebidas.length > 0) {
        json(res, 422, {
          erro: "Somente campanhaId é aceito — nenhuma autoridade adicional do cliente.",
          codigo: "CAMPAIGN_CANARY_BODY_AUTHORITY",
        });
        return;
      }
      const politica = carregarPoliticaCampanhaAtualizacao();
      // SLICE-03C.2A.1 (Matriz A) — armamento ausente: gate de POLÍTICA antes
      // de qualquer leitura de banco, evento, token ou provider (409 estável;
      // ZERO tudo).
      if (!politica.canarySendEnabled) {
        json(res, 409, {
          erro: "Envio do canário não está armado — nenhuma execução foi iniciada.",
          codigo: "CAMPAIGN_CANARY_SEND_DISABLED",
          bloqueios: ["CANARY_SEND_DISABLED"],
          claims: 0,
        });
        return;
      }
      // SLICE-03C.2A.1 (Seção C) — provider via DI exclusiva para teste;
      // runtime normal constrói o provider Gmail da campanha.
      const resultado = await enviarCanarioCampanha(requireDbPool(), {
        operatorId: identity.operatorId,
        campanhaId: body.campanhaId as string,
        politica,
        provider: provedorCanarioRuntime(body.campanhaId as string),
        contexto: { fingerprinter: fingerprinter() },
      });
      if (resultado.tipo === "BLOQUEADO") {
        // ZERO CLAIM OBRIGATÓRIO: bloqueios do preflight, sanitizados.
        json(res, 409, {
          erro: "Envio do canário bloqueado — nenhuma execução foi iniciada.",
          codigo: "CAMPAIGN_CANARY_BLOCKED",
          bloqueios: resultado.bloqueios,
          claims: 0,
        });
        return;
      }
      const tentativa = resultado.resultado;
      json(res, 200, {
        resultado: tentativa.resultado,
        itemId: tentativa.itemId,
        ...(tentativa.resultado === "NAO_CLAIMADO" ? { claim: tentativa.claim } : {}),
        ...(tentativa.resultado === "ENVIADO" ? { receipt: tentativa.receipt } : {}),
        ...(tentativa.resultado === "FALHA_PRE_PROVIDER" ||
          tentativa.resultado === "FALHA_DEFINITIVA" ||
          tentativa.resultado === "AMBIGUO"
          ? { motivo: tentativa.motivo }
          : {}),
      });
    },
  },
  {
    // SLICE-03C.1 — RUNTIME HARD-DISABLE. Nenhum provider de execução existe
    // no runtime nesta fatia: o entrypoint de TENTATIVA falha ANTES de provas,
    // claim, mutação, INSERT de execução, provider ou Gmail — mesmo que todas
    // as políticas estejam abertas, o lote esteja ATIVO, o item PREPARADO, a
    // autorização vigente e o canário selecionado. O provider Gmail só será
    // conectado no 03C.2, com nova autorização do owner. A validação de
    // sessão/identidade permanece (a rota segue autenticada); nenhum estado
    // operacional é lido ou escrito aqui.
    metodo: "POST",
    caminhoExato: "/api/campaigns/execute-attempt",
    handler: async (req, res, _url, _corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      json(res, 409, {
        erro:
          "Execução desabilitada no runtime — nenhum provider está montado nesta fatia e nenhum item se torna executável.",
        codigo: "CAMPAIGN_PROVIDER_DISABLED",
        executavel: false,
        providerReady: false,
      });
    },
  },
  {
    // SLICE-03C.1 — ATIVAÇÃO EXPLÍCITA do lote (PREPARADO → ATIVO), com
    // seleção durável de canário server-side na MESMA transação. O corpo
    // aceita EXCLUSIVAMENTE campanhaId (UUID): operatorId, loteCampanhaId,
    // itemId, e-mail, fingerprint, proofKey, estado, chave idempotente e
    // provider são resolvidos server-side (sessão + banco + configuração) e
    // NUNCA do cliente. A resposta não contém e-mail, fingerprint nem segredo.
    metodo: "POST",
    caminhoExato: "/api/campaigns/activate",
    handler: async (req, res, _url, corpo) => {
      const identity = await exigirOperadorCampanha(req, res, CAMPAIGN_OPERATIONAL_ROLES);
      if (!identity) return;
      let body: { campanhaId?: unknown };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido.", codigo: "CAMPAIGN_ACTIVATE_JSON_INVALID" });
        return;
      }
      if (!operatorUuidValido(body.campanhaId)) {
        json(res, 422, {
          erro: "campanhaId (UUID) é obrigatório.",
          codigo: "CAMPAIGN_ACTIVATE_INVALID",
        });
        return;
      }
      try {
        const resultado = await ativarLoteCampanha(
          requireDbPool(),
          {
            operatorId: identity.operatorId,
            campanhaId: body.campanhaId as string,
            politica: carregarPoliticaCampanhaAtualizacao(),
            papeisOperador: identity.roles,
          },
        );
        if (!resultado) {
          // Alheio/inexistente indistinguíveis — 404 sanitizado, sem mutação.
          json(res, 404, {
            erro: "Nenhuma campanha persistida para este identificador.",
            codigo: "CAMPAIGN_PERSISTED_NOT_FOUND",
          });
          return;
        }
        json(res, 200, {
          status:
            resultado.resultado === "ATIVADO"
              ? "CAMPAIGN_BATCH_ACTIVATED"
              : "CAMPAIGN_BATCH_ALREADY_ACTIVATED",
          campanhaId: resultado.campanhaId,
          lote: {
            loteCampanhaId: resultado.loteCampanhaId,
            codigo: resultado.loteCodigo,
            totalItens: resultado.totalItens,
          },
          canarioReferenciaPresente: true,
          executavel: false,
          providerReady: false,
          aviso:
            "Lote ATIVO permanece não executável: provider indisponível, nenhum item foi enfileirado e o Gmail não foi chamado.",
        });
      } catch (error) {
        erroControleCampanha(res, error);
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/operator/admin/provision",
    handler: async (req, res, _url, corpo) => {
      const admin = await exigirOperadorCampanha(req, res, ["ADMIN_TECNICO"]);
      if (!admin) return;

      let body: {
        code?: unknown;
        displayName?: unknown;
        roles?: unknown;
        credentialHash?: unknown;
        tokenExpiresAt?: unknown;
      };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }

      const roles = Array.isArray(body.roles) ? body.roles : [];
      const rolesValid = roles.length > 0 && roles.every(
        (role) => typeof role === "string" &&
          ["PREPARADOR","REVISOR","APROVADOR","EXECUTOR","SUPERVISOR","ADMIN_TECNICO"].includes(role),
      );
      const now = new Date();
      if (
        !textoOperadorValido(body.code, 80) ||
        !textoOperadorValido(body.displayName, 160) ||
        !rolesValid ||
        !credentialHashValido(body.credentialHash) ||
        !expiracaoTokenValida(body.tokenExpiresAt, now)
      ) {
        json(res, 422, {
          erro: "Dados de provisionamento inválidos.",
          codigo: "OPERATOR_PROVISION_INVALID",
        });
        return;
      }

      const operatorId = randomUUID();
      try {
        await operatorIdentityRepository().provisionOperator({
          actorOperatorId: admin.operatorId,
          operatorId,
          code: body.code,
          displayName: body.displayName,
          roles: roles as OperatorRole[],
          tokenHash: body.credentialHash,
          now: now.toISOString(),
          ...(typeof body.tokenExpiresAt === "string"
            ? { tokenExpiresAt: body.tokenExpiresAt }
            : {}),
        });
        json(res, 201, {
          operatorId,
          status: "ATIVO",
          roles: [...new Set(roles as string[])].sort(),
          provisionedBy: admin.operatorId,
        });
      } catch (error) {
        if (error instanceof OperatorAdminAuthorizationError) {
          json(res, 403, {
            erro: "Administrador técnico individual não está mais autorizado.",
            codigo: "OPERATOR_ADMIN_AUTH_STALE",
          });
          return;
        }
        if ((error as { code?: unknown })?.code === "23505") {
          json(res, 409, {
            erro: "Operador ou credencial já provisionados.",
            codigo: "OPERATOR_EXISTS",
          });
          return;
        }
        json(res, 503, {
          erro: "Provisionamento operacional indisponível.",
          codigo: "OPERATOR_PROVISION_UNAVAILABLE",
        });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/operator/admin/credentials/rotate",
    handler: async (req, res, _url, corpo) => {
      const admin = await exigirOperadorCampanha(req, res, ["ADMIN_TECNICO"]);
      if (!admin) return;

      let body: {
        operatorId?: unknown;
        credentialHash?: unknown;
        tokenExpiresAt?: unknown;
      };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      const now = new Date();
      if (
        !operatorUuidValido(body.operatorId) ||
        !credentialHashValido(body.credentialHash) ||
        !expiracaoTokenValida(body.tokenExpiresAt, now)
      ) {
        json(res, 422, {
          erro: "Dados de rotação inválidos.",
          codigo: "OPERATOR_CREDENTIAL_ROTATION_INVALID",
        });
        return;
      }

      try {
        const replaced = await operatorIdentityRepository().replaceCredential({
          actorOperatorId: admin.operatorId,
          operatorId: body.operatorId,
          tokenHash: body.credentialHash,
          reason: "ROTACAO",
          now: now.toISOString(),
          ...(typeof body.tokenExpiresAt === "string"
            ? { tokenExpiresAt: body.tokenExpiresAt }
            : {}),
        });
        if (!replaced) {
          json(res, 404, {
            erro: "Operador ativo não encontrado.",
            codigo: "OPERATOR_NOT_ACTIVE",
          });
          return;
        }
        json(res, 200, {
          operatorId: body.operatorId,
          status: "CREDENTIAL_ROTATED",
          sessionsRevoked: true,
          performedBy: admin.operatorId,
        });
      } catch (error) {
        if (error instanceof OperatorAdminAuthorizationError) {
          json(res, 403, {
            erro: "Administrador técnico individual não está mais autorizado.",
            codigo: "OPERATOR_ADMIN_AUTH_STALE",
          });
          return;
        }
        json(res, 503, {
          erro: "Rotação de credencial indisponível.",
          codigo: "OPERATOR_CREDENTIAL_ROTATION_UNAVAILABLE",
        });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/operator/admin/credentials/recover",
    handler: async (req, res, _url, corpo) => {
      const admin = await exigirOperadorCampanha(req, res, ["ADMIN_TECNICO"]);
      if (!admin) return;

      let body: {
        operatorId?: unknown;
        credentialHash?: unknown;
        tokenExpiresAt?: unknown;
      };
      try {
        body = JSON.parse(corpo.toString("utf8") || "{}") as typeof body;
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      const now = new Date();
      if (
        !operatorUuidValido(body.operatorId) ||
        !credentialHashValido(body.credentialHash) ||
        !expiracaoTokenValida(body.tokenExpiresAt, now)
      ) {
        json(res, 422, {
          erro: "Dados de recuperação inválidos.",
          codigo: "OPERATOR_CREDENTIAL_RECOVERY_INVALID",
        });
        return;
      }

      try {
        const replaced = await operatorIdentityRepository().replaceCredential({
          actorOperatorId: admin.operatorId,
          operatorId: body.operatorId,
          tokenHash: body.credentialHash,
          reason: "RECUPERACAO",
          now: now.toISOString(),
          ...(typeof body.tokenExpiresAt === "string"
            ? { tokenExpiresAt: body.tokenExpiresAt }
            : {}),
        });
        if (!replaced) {
          json(res, 404, {
            erro: "Operador ativo não encontrado.",
            codigo: "OPERATOR_NOT_ACTIVE",
          });
          return;
        }
        json(res, 200, {
          operatorId: body.operatorId,
          status: "CREDENTIAL_RECOVERED",
          sessionsRevoked: true,
          performedBy: admin.operatorId,
        });
      } catch (error) {
        if (error instanceof OperatorAdminAuthorizationError) {
          json(res, 403, {
            erro: "Administrador técnico individual não está mais autorizado.",
            codigo: "OPERATOR_ADMIN_AUTH_STALE",
          });
          return;
        }
        json(res, 503, {
          erro: "Recuperação de credencial indisponível.",
          codigo: "OPERATOR_CREDENTIAL_RECOVERY_UNAVAILABLE",
        });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/operator/admin/suspend",
    handler: async (req, res, _url, corpo) => {
      const admin = await exigirOperadorCampanha(req, res, ["ADMIN_TECNICO"]);
      if (!admin) return;

      let operatorId = "";
      try {
        const body = JSON.parse(corpo.toString("utf8") || "{}") as { operatorId?: unknown };
        operatorId = typeof body.operatorId === "string" ? body.operatorId : "";
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      if (!operatorUuidValido(operatorId)) {
        json(res, 422, {
          erro: "Identificador do operador inválido.",
          codigo: "OPERATOR_SUSPEND_INVALID",
        });
        return;
      }
      try {
        const suspended = await operatorIdentityRepository().suspendOperator(
          operatorId,
          admin.operatorId,
          new Date().toISOString(),
        );
        if (!suspended) {
          json(res, 404, { erro: "Operador ativo não encontrado.", codigo: "OPERATOR_NOT_ACTIVE" });
          return;
        }
        json(res, 200, {
          operatorId,
          status: "SUSPENSO",
          sessionsRevoked: true,
          performedBy: admin.operatorId,
        });
      } catch (error) {
        if (error instanceof OperatorAdminAuthorizationError) {
          json(res, 403, {
            erro: "Administrador técnico individual não está mais autorizado.",
            codigo: "OPERATOR_ADMIN_AUTH_STALE",
          });
          return;
        }
        if (error instanceof OperatorAdminContinuityError) {
          json(res, 409, {
            erro: "Suspensão recusada para preservar administração técnica ativa.",
            codigo: "OPERATOR_ADMIN_CONTINUITY_REQUIRED",
          });
          return;
        }
        json(res, 503, {
          erro: "Suspensão operacional indisponível.",
          codigo: "OPERATOR_SUSPEND_UNAVAILABLE",
        });
      }
    },
  },

  // ------------------------------------------------------------------
  // ADMIN — listagem de operadores para a área administrativa da UI.
  // Exige sessão individual ativa + ADMIN_TECNICO. Somente dados
  // operacionais e estados agregados de credencial; nenhum segredo.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/operator/admin/operators",
    handler: async (req, res, url) => {
      const admin = await exigirOperadorCampanha(req, res, ["ADMIN_TECNICO"]);
      if (!admin) return;

      const limitBruto = Number(url.searchParams.get("limit") ?? "50");
      const offsetBruto = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number.isSafeInteger(limitBruto) ? limitBruto : 0;
      const offset = Number.isSafeInteger(offsetBruto) ? offsetBruto : -1;
      if (limit < 1 || limit > 100 || offset < 0) {
        json(res, 422, {
          erro: "Parâmetros de paginação inválidos (limit 1–100, offset ≥ 0).",
          codigo: "OPERATOR_LIST_INVALID_PAGINATION",
        });
        return;
      }

      try {
        const operadores = await operatorIdentityRepository().listOperators(
          limit,
          offset,
          new Date().toISOString(),
        );
        json(res, 200, { operadores });
      } catch {
        json(res, 503, {
          erro: "Listagem de operadores indisponível.",
          codigo: "OPERATOR_LIST_UNAVAILABLE",
        });
      }
    },
  },

  // ------------------------------------------------------------------
  // READINESS — OPERATOR_ROUTE (estado detalhado dos subsistemas).
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/readiness",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const report = await avaliarReadiness(
        process.env,
        () => sondarDatabase(process.env),
        async () => {
          if (!process.env.DATABASE_URL?.trim() || !process.env.DATA_ENCRYPTION_KEY_BASE64?.trim()) return false;
          try {
            const { repository } = requireDb();
            return await repository.existeConexaoGmailAtiva();
          } catch {
            return false;
          }
        },
      );
      json(res, 200, report);
    },
  },

  // ------------------------------------------------------------------
  // INTAKE — OPERATOR_ROUTE (upload/preflight/confirm de XLSX real).
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/intake/analyze",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      try {
        const nome = parseFileNameHeader(req.headers["x-file-name"]?.toString());
        const folha = req.headers["x-sheet-name"]?.toString();
        const linhaCabecalho = req.headers["x-header-row"]?.toString();
        const analise = analisarXlsx(
          nome,
          new Uint8Array(corpo),
          folha,
          linhaCabecalho ? Number.parseInt(linhaCabecalho, 10) : undefined,
        );
        json(res, 200, analise);
      } catch (error) {
        if (error instanceof ContratoInvalidoError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 422, { erro: "Arquivo não pôde ser analisado (formato/estrutura inválida)." });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/intake/preflight",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      try {
        const nome = parseFileNameHeader(req.headers["x-file-name"]?.toString());
        const folha = req.headers["x-sheet-name"]?.toString();
        const linhaCabecalho = req.headers["x-header-row"]?.toString();
        const mapeamento = parseMappingHeader(req.headers["x-mapping"]?.toString());
        const input: PreflightInput = {
          nomeArquivo: nome,
          bytes: new Uint8Array(corpo),
          ...(folha ? { folha } : {}),
          ...(linhaCabecalho ? { linhaCabecalho: Number.parseInt(linhaCabecalho, 10) } : {}),
          mapeamento: mapeamento as PreflightInput["mapeamento"],
        };
        json(res, 200, executarPreflight(input));
      } catch (error) {
        if (error instanceof ContratoInvalidoError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        if (error instanceof MapeamentoInvalidoError) {
          json(res, 400, {
            erro: "Mapeamento inválido.",
            codigo: "MAPPING_INVALID",
            detalhes: error.erros,
          });
          return;
        }
        json(res, 422, { erro: "Preflight não pôde ser executado (arquivo/mapping inválidos)." });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/intake/confirm",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      try {
        const { pool, repository } = requireDb();
        const nome = parseFileNameHeader(req.headers["x-file-name"]?.toString());
        const folha = req.headers["x-sheet-name"]?.toString();
        const linhaCabecalho = req.headers["x-header-row"]?.toString();
        const mapeamento = parseMappingHeader(req.headers["x-mapping"]?.toString());
        const resultado = await confirmarImportacao(
          {
            nomeArquivo: nome,
            bytes: new Uint8Array(corpo),
            ...(folha ? { folha } : {}),
            ...(linhaCabecalho ? { linhaCabecalho: Number.parseInt(linhaCabecalho, 10) } : {}),
            mapeamento: mapeamento as PreflightInput["mapeamento"],
            operador: "operador-autenticado",
          },
          repository,
        );
        json(res, 200, resultado);
      } catch (error) {
        if (error instanceof ContratoInvalidoError) {
          json(res, 400, { erro: error.message, codigo: error.codigo });
          return;
        }
        if (error instanceof MapeamentoInvalidoError) {
          json(res, 400, {
            erro: "Mapeamento inválido.",
            codigo: "MAPPING_INVALID",
            detalhes: error.erros,
          });
          return;
        }
        const mensagem = error instanceof Error ? error.message : "Falha na importação.";
        if (mensagem.includes("Configuração de criptografia")) {
          json(res, 503, { erro: "Persistência não configurada (chaves ausentes)." });
          return;
        }
        json(res, 422, { erro: "Importação não pôde ser confirmada (arquivo/mapping inválidos)." });
      }
    },
  },

  // ------------------------------------------------------------------
  // COCKPIT / PILOTO — OPERATOR_ROUTE.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/professionals",
    handler: async (req, res, url) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const filtro = (url.searchParams.get("filtro") ?? "TODOS") as FiltroCockpit;
      const profissionais = await listarProfissionais(pool, filtro, caixa());
      json(res, 200, { profissionais });
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/preview",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const selecao = JSON.parse(corpo.toString("utf8")) as { professionalIds: string[] };
      const policy = carregarPilotPolicy();
      if (selecao.professionalIds.length > policy.maxRecipients) {
        json(res, 422, {
          erro: `Seleção de ${selecao.professionalIds.length} excede o limite do piloto (${policy.maxRecipients}).`,
        });
        return;
      }
      const profissionais = await listarProfissionais(pool, "TODOS", caixa());
      const escolhidos = profissionais.filter((p) => selecao.professionalIds.includes(p.id));
      const baseUrl = process.env.CONFIRMATION_BASE_URL ?? "https://preview.exemplo.test";
      const previews = escolhidos.map((p) =>
        gerarPreviewComunicacao(
          p.id,
          p.codigo,
          p.nome,
          "destinatario@exemplo.test", // preview nunca usa e-mail real na UI
          p.enderecoResumo,
          p.telefoneMascarado,
          baseUrl,
        ),
      );
      json(res, 200, {
        previews,
        remetente: "CRT-BA | Carteiras Profissionais <carteiras@crtba.org.br>",
        quantidade: previews.length,
        maximo: policy.maxRecipients,
        aviso: "Preview não envia. O envio real permanece bloqueado (REAL_SEND_ENABLED=false).",
      });
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/prepare",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      const selecao = JSON.parse(corpo.toString("utf8")) as { professionalIds: string[] };
      const policy = carregarPilotPolicy();
      const tokens = createWebTokenService();
      try {
        const resultado = await prepararLotePiloto(
          {
            professionalIds: selecao.professionalIds,
            operador: "operador-autenticado",
            confirmationBaseUrl: process.env.CONFIRMATION_BASE_URL ?? "https://preview.exemplo.test",
            source: "INSTITUCIONAL_XLSX",
          },
          repository,
          pool,
          caixa(),
          fingerprinter(),
          policy,
          tokens,
        );
        json(res, 200, resultado);
      } catch (error) {
        if (error instanceof LotePilotoEmAndamentoError) {
          json(res, 409, {
            erro: error.message,
            codigo: "BATCH_ALREADY_IN_PROGRESS",
            lote: error.lote,
          });
          return;
        }
        const pg = error as { code?: string; constraint?: string };
        if (pg?.code === "23505" && pg.constraint === "item_lote_profissional_ativo_idx") {
          json(res, 409, {
            erro: "Um ou mais profissionais já pertencem a um lote de comunicação em andamento.",
            codigo: "BATCH_ALREADY_IN_PROGRESS",
          });
          return;
        }
        json(res, 422, { erro: "Falha na preparação do lote." });
      }
    },
  },

  // ------------------------------------------------------------------
  // TESTE CONTROLADO GMAIL — estado read-only (pré-voo) e preparação
  // idempotente do lote sintético CONTROLLED_GMAIL_TEST (exatamente 1
  // comunicação para o destinatário controlado). Nenhum envio aqui:
  // REAL_SEND_ENABLED=false + lote PREPARACAO mantêm GATE 1/2 fechados.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/pilot/controlled/state",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const estado = await lerEstadoLoteControlado(pool, {
        caixa: caixa(),
        controlledRecipient: (process.env.GMAIL_CONTROLLED_RECIPIENT ?? "").trim(),
      });
      json(res, 200, estado);
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/controlled/prepare",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      try {
        const resultado = await prepararLoteTesteControlado(
          {
            operador: "operador-autenticado",
            confirmationBaseUrl: process.env.CONFIRMATION_BASE_URL ?? "https://preview.exemplo.test",
            oauthPronto: await oauthGmailPronto(),
          },
          repository,
          pool,
          caixa(),
          fingerprinter(),
          createWebTokenService(),
          carregarPoliticaControlada(),
        );
        json(res, 200, resultado);
      } catch (error) {
        if (error instanceof BloqueioLoteControladoError) {
          json(res, 409, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 422, { erro: "Falha na preparação do lote controlado." });
      }
    },
  },

  // ------------------------------------------------------------------
  // RECOVERY — restaura o lote persistido após refresh/reabertura da UI.
  // Sem mutação: apenas lê o lote PF/DRY_RUN em PREPARACAO/ATIVO e a outbox.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/pilot/recovery",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const lote = await recuperarLotePilotoEmAndamento(pool);
      if (!lote) {
        json(res, 200, { lote: null, itens: [] });
        return;
      }
      json(res, 200, {
        lote,
        itens: await statusOutbox(pool, lote.loteId),
      });
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/pilot/outbox",
    handler: async (req, res, url) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const loteId = url.searchParams.get("loteId") ?? undefined;
      json(res, 200, { itens: await statusOutbox(pool, loteId) });
    },
  },

  // ------------------------------------------------------------------
  // LIBERAÇÃO DE LOTE (GATE 2) — OPERATOR_ROUTE, ação humana deliberada:
  // CAS PREPARACAO → ATIVO + hard cap revalidado server-side.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/activate",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      const body = JSON.parse(corpo.toString("utf8") || "{}") as { loteId?: string };
      if (!body.loteId) {
        json(res, 422, { erro: "loteId obrigatório.", codigo: "BLOCKED_INVALID_BATCH" });
        return;
      }
      const policy = carregarPilotPolicy();
      const estado = await pool.query<{ total: string; status: string }>(
        `SELECT (SELECT count(*) FROM item_lote_comunicacao WHERE lote_comunicacao_id = $1) AS total,
          (SELECT status FROM lote_comunicacao WHERE id = $1) AS status`,
        [body.loteId],
      );
      const total = Number(estado.rows[0]?.total ?? 0);
      if (total < 1) {
        json(res, 422, { erro: "Lote sem itens.", codigo: "BLOCKED_EMPTY_BATCH" });
        return;
      }
      if (total > policy.maxRecipients) {
        json(res, 422, {
          erro: `Lote com ${total} itens excede o limite do piloto (${policy.maxRecipients}).`,
          codigo: "BLOCKED_PILOT_LIMIT",
        });
        return;
      }
      const agora = new Date().toISOString();
      const operador = "operador-autenticado";
      try {
        const resultado = await repository.ativarLoteComunicacao({
          batchId: body.loteId,
          origin: "PF",
          actorId: operador,
          activatedAt: agora,
          auditEvent: {
            id: randomUUID(),
            aggregateType: "LOTE_COMUNICACAO",
            aggregateId: body.loteId,
            type: "PF_LOTE_COMUNICACAO_ATIVADO",
            actorId: operador,
            occurredAt: agora,
            metadata: { totalItens: total },
            eventHash: hashEvento(body.loteId, agora),
          },
        });
        json(res, 200, {
          resultado,
          modoEnvio: "DISABLED",
          aviso: "Lote ATIVO para DRY_RUN. Envio real permanece bloqueado (REAL_SEND_ENABLED=false).",
        });
      } catch (error) {
        const mensagem = error instanceof Error ? error.message : "Falha na ativação.";
        const codigo = mensagem.includes("ALREADY_ACTIVE")
          ? "ALREADY_ACTIVE"
          : mensagem.includes("INVALID_STATE")
            ? "BLOCKED_INVALID_STATE"
            : mensagem.includes("ALREADY_SENT")
              ? "BLOCKED_ALREADY_SENT"
              : "BLOCKED_ACTIVATION";
        json(res, 409, { erro: mensagem, codigo });
      }
    },
  },

  // ------------------------------------------------------------------
  // ATIVAÇÃO AUDITADA do lote CONTROLLED_GMAIL_TEST — OPERATOR_ROUTE. Ação
  // humana deliberada com confirmação textual; reutiliza o CAS de ativação
  // existente (PF_LOTE_COMUNICACAO_ATIVADO) restrito ao lote canônico.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/controlled/activate",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      const body = JSON.parse(corpo.toString("utf8") || "{}") as {
        loteId?: string;
        confirmacao?: string;
      };
      if (!body.loteId || !body.confirmacao) {
        json(res, 422, {
          erro: "loteId e confirmação humana obrigatórios.",
          codigo: "BLOCKED_ACTIVATE_INPUT",
        });
        return;
      }
      const confirmacaoEsperada =
        "AUTORIZO ATIVAR O LOTE CONTROLLED_GMAIL_TEST PARA ENVIO REAL CONTROLADO " +
        "DE UMA ÚNICA MENSAGEM AO DESTINATÁRIO SOB MEU CONTROLE";
      if (body.confirmacao.trim() !== confirmacaoEsperada) {
        json(res, 422, {
          erro: "Confirmação humana não corresponde ao texto obrigatório.",
          codigo: "BLOCKED_ACTIVATE_CONFIRMATION",
        });
        return;
      }
      try {
        const resultado = await ativarLoteControlado(
          { loteId: body.loteId, operador: "operador-autenticado" },
          repository,
          pool,
          carregarPoliticaControlada(),
        );
        json(res, 200, {
          resultado,
          aviso:
            "Lote controlado ATIVO. O envio em si permanece bloqueado até REAL_SEND_ENABLED=true (redeploy do Preview).",
        });
      } catch (error) {
        if (error instanceof BloqueioLoteControladoError) {
          json(res, 409, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 500, { erro: "Falha na ativação do lote controlado." });
      }
    },
  },

  // ------------------------------------------------------------------
  // ENVIO LIVE CONTROLADO — OPERATOR_ROUTE, exatamente UMA tentativa.
  // Pré-voo fail-closed server-side; nenhum retry e nenhuma segunda chamada.
  // A rota DRY_RUN (/api/pilot/worker/run-once) permanece intocada.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/controlled/execute",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      if (process.env.REAL_SEND_ENABLED !== "true") {
        json(res, 409, {
          erro: "REAL_SEND_ENABLED=false — envio real não está armado.",
          codigo: "REAL_SEND_DISABLED",
        });
        return;
      }
      try {
        const resultado = await executarWorkerControladoUmaVez(
          pool,
          carregarPoliticaControlada(),
          executarWorkerUmaVezLive,
          {
            // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED: bloqueio ANTES do claim —
            // sem MAIL_PROVIDER=Gmail a rota responde SEM mutação.
            providerGmailConfigurado: carregarPoliticaProvider().providerGmailConfigurado,
            retryAutorizado: await retryPreRedeAutorizado(pool),
          },
        );
        // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — a resposta nunca anuncia
        // execução concluída quando sentItems=0 ou falhas>0; motivo do motor é
        // propagado sanitizado. Nenhum destinatário, token ou payload.
        const ok = resultado.executado && resultado.sentItems > 0 && resultado.falhas === 0;
        json(res, ok ? 200 : 409, {
          resultado,
          ...(ok
            ? { aviso: "Envio real controlado registrado (1 mensagem). Desarmar REAL_SEND_ENABLED imediatamente." }
            : {
                erro:
                  resultado.motivoBloqueio
                    ? `Execução interrompida pelo motor: ${resultado.motivoBloqueio}.`
                    : `Nenhuma comunicação enviada (outbox: ${resultado.statusOutbox}, tentativas: ${resultado.tentativas}, erro: ${resultado.erroCodigo ?? "—"}).`,
                codigo: resultado.motivoBloqueio ?? "EXECUTION_NOT_COMPLETED",
              }),
        });
      } catch (error) {
        // PRE_CLAIM_500_DIAGNOSIS — falhas esperadas mapeadas para 409/503 com
        // codigo sanitizado; log estruturado sem mensagem bruta/PII. O erro
        // original (ex.: 42703) nunca ecoa na resposta.
        const fase = "controlled.execute";
        const requestId = randomUUID();
        if (error instanceof BloqueioExecucaoControladaError) {
          const mapeado = mapearFalhaExecucao(error);
          registrarFalhaExecucao(fase, mapeado, { requestId });
          json(res, mapeado.status, { erro: error.message, codigo: mapeado.codigo });
          return;
        }
        const mapeado = mapearFalhaExecucao(error);
        registrarFalhaExecucao(fase, mapeado, { requestId });
        json(res, mapeado.status, {
          erro: "Execução controlada temporariamente indisponível — tente novamente; nada foi enviado nem mutado.",
          codigo: mapeado.codigo,
        });
        return;
      }
    },
  },

  // ------------------------------------------------------------------
  // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — nova tentativa controlada
  // EXCLUSIVA para o erro comprovadamente pré-rede (FAILED +
  // PROVIDER_NOT_CONFIGURED + tentativas=1 + receipt=0 + sem provider ids).
  // Exige confirmação humana textual específica e registra o evento auditado
  // PF_CONTROLLED_RETRY_AUTORIZADO. DELIVERY_UNKNOWN, AUTH_REQUIRED,
  // FAILED_PERMANENT, PROCESSING ou falha pós-rede NUNCA são elegíveis.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/controlled/retry",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const body = JSON.parse(corpo.toString("utf8") || "{}") as { confirmacao?: string };
      const confirmacaoEsperada =
        "AUTORIZO NOVA TENTATIVA CONTROLADA DO LOTE CONTROLLED_GMAIL_TEST APÓS FALHA PRÉ-REDE " +
        "PROVIDER_NOT_CONFIGURED, PRESERVANDO A TENTATIVA FALHA E SEM REPETIR OUTRAS FALHAS";
      if (!body.confirmacao || body.confirmacao.trim() !== confirmacaoEsperada) {
        json(res, 422, {
          erro: "Confirmação humana não corresponde ao texto obrigatório.",
          codigo: "BLOCKED_RETRY_CONFIRMATION",
        });
        return;
      }
      if (process.env.REAL_SEND_ENABLED === "true") {
        json(res, 409, {
          erro: "REAL_SEND_ENABLED=true — autorização de retry exige envio desarmado.",
          codigo: "REAL_SEND_ARMED",
        });
        return;
      }
      try {
        const resultado = await autorizarRetryPreRede(pool, "operador-autenticado");
        json(res, 200, {
          ...resultado,
          aviso: "Nova tentativa auditada e registrada. A execução só ocorre com MAIL_PROVIDER=Gmail e REAL_SEND_ENABLED=true em etapa separada.",
        });
      } catch (error) {
        if (error instanceof BloqueioExecucaoControladaError) {
          json(res, 409, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 500, { erro: "Falha ao registrar a nova tentativa." });
      }
    },
  },

  // ------------------------------------------------------------------
  // OUTBOX_GATE_CHAIN_FIX — recuperação auditada EXCLUSIVA da outbox do
  // teste que falhou em CONTROLLED_GATE_OAUTH_NOT_READY (bloqueio de gate
  // PRÉ-messages.send: zero chamada Gmail, OAuth persistido ativo).
  // Fail-closed: somente esse código + tentativas=2 + receipt=0 + sem
  // provider ids + fila zerada + REAL_SEND_ENABLED=false; confirmação
  // humana textual específica; idempotente (já recuperado → estado atual);
  // evento PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO na MESMA transação
  // do UPDATE para PENDING. Outras falhas NUNCA são elegíveis.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/controlled/oauth-recovery",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool } = requireDb();
      const body = JSON.parse(corpo.toString("utf8") || "{}") as { confirmacao?: string };
      const confirmacaoEsperada =
        "AUTORIZO RECUPERACAO AUDITADA DO OUTBOX DO LOTE CONTROLLED_GMAIL_TEST FALHADO " +
        "POR CONTROLLED_GATE_OAUTH_NOT_READY, SEM CHAMADA MESSAGES.SEND, SEM REUTILIZAR " +
        "RETRY ANTERIOR E MANTENDO TODOS OS DADOS";
      if (!body.confirmacao || body.confirmacao.trim() !== confirmacaoEsperada) {
        json(res, 422, {
          erro: "Confirmação humana não corresponde ao texto obrigatório.",
          codigo: "BLOCKED_RECOVERY_CONFIRMATION",
        });
        return;
      }
      if (process.env.REAL_SEND_ENABLED === "true") {
        json(res, 409, {
          erro: "REAL_SEND_ENABLED=true — recuperação exige envio desarmado.",
          codigo: "REAL_SEND_ARMED",
        });
        return;
      }
      const repository = new PostgresOperationalRepository(pool);
      try {
        const resultado = await autorizarRecuperacaoOauthGate(
          repository,
          "operador-autenticado",
          false,
        );
        json(res, 200, {
          ...resultado,
          aviso:
            resultado.resultCode === "ALREADY_RECOVERED"
              ? "Recuperação já registrada anteriormente — estado atual preservado, sem nova mutação."
              : "Outbox recuperada para PENDING e evento auditado registrado. A execução só ocorre com OAuth READY, MAIL_PROVIDER=Gmail e REAL_SEND_ENABLED=true em etapa separada.",
        });
      } catch (error) {
        if (error instanceof BloqueioExecucaoControladaError) {
          json(res, 409, { erro: error.message, codigo: error.codigo });
          return;
        }
        // CORRECTIVE_RECOVERY_SQL_SYNTAX — log estruturado SANITIZADO: fase,
        // SQLSTATE (código do driver, sem mensagem) e classe do erro. A
        // mensagem bruta pode conter fragmento de SQL/DSN e nunca é ecoada
        // no log nem na resposta.
        const sqlstate =
          typeof error === "object" && error !== null && "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : null;
        console.error(
          JSON.stringify({
            fase: "controlled.oauth-recovery",
            classeErro: error instanceof Error ? error.name : "Unknown",
            ...(sqlstate && /^[0-9A-Z]{5}$/.test(sqlstate) ? { sqlstate } : {}),
          }),
        );
        json(res, 500, { erro: "Falha ao registrar a recuperação." });
      }
    },
  },

  // ------------------------------------------------------------------
  // CANCELAMENTO AUDITADO do lote DRY_RUN histórico — OPERATOR_ROUTE,
  // ação humana deliberada com confirmação específica. Fail-closed:
  //   - somente o lote EXATO PF-MAIL-PILOTO-MUB37G1H (código + ATIVO/DRY_RUN);
  //   - REAL_SEND_ENABLED=false obrigatório (lido do ambiente);
  //   - confirmação textual humana obrigatória;
  //   - idempotente: já CANCELADO → estado atual sem nova mutação;
  //   - preserva itens, comunicações, outbox, confirmações e imports;
  //   - único evento PF_LOTE_COMUNICACAO_CANCELADO, motivo
  //     HISTORICAL_DRY_RUN_ISOLATION, sem PII.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/batch/cancel",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      const body = JSON.parse(corpo.toString("utf8") || "{}") as {
        loteId?: string;
        confirmacao?: string;
      };
      if (!body.loteId || !body.confirmacao) {
        json(res, 422, {
          erro: "loteId e confirmação humana obrigatórios.",
          codigo: "BLOCKED_CANCEL_INPUT",
        });
        return;
      }
      // Confirmação humana específica: texto exato, sem espécie de variável.
      const confirmacaoEsperada =
        "AUTORIZO CANCELAR DE FORMA AUDITADA O LOTE DRY_RUN HISTÓRICO " +
        "PF-MAIL-PILOTO-MUB37G1H, PRESERVANDO TODOS OS DADOS E SEM EXECUTAR O WORKER";
      if (body.confirmacao.trim() !== confirmacaoEsperada) {
        json(res, 422, {
          erro: "Confirmação humana não corresponde ao texto obrigatório.",
          codigo: "BLOCKED_CANCEL_CONFIRMATION",
        });
        return;
      }
      if (process.env.REAL_SEND_ENABLED === "true") {
        json(res, 409, {
          erro: "REAL_SEND_ENABLED=true — cancelamento bloqueado.",
          codigo: "REAL_SEND_ARMED",
        });
        return;
      }
      try {
        const contexto = await pool.query<{ codigo: string; status: string; modo: string }>(
          `SELECT codigo, status, modo FROM lote_comunicacao WHERE id = $1 AND origem = 'PF'`,
          [body.loteId],
        );
        validarCancelamentoLoteHistorico(contexto.rows[0]);
        const agora = new Date().toISOString();
        const operador = "operador-autenticado";
        const estado = await repository.cancelarLoteComunicacao({
          batchId: body.loteId,
          origin: "PF",
          expectedCode: CODIGO_LOTE_HISTORICO_DRY_RUN,
          realSendEnabled: process.env.REAL_SEND_ENABLED === "true",
          actorId: operador,
          cancelledAt: agora,
          auditEvent: {
            id: randomUUID(),
            aggregateType: "LOTE_COMUNICACAO",
            aggregateId: body.loteId,
            type: "PF_LOTE_COMUNICACAO_CANCELADO",
            actorId: operador,
            occurredAt: agora,
            metadata: { motivo: "HISTORICAL_DRY_RUN_ISOLATION", modo: "DRY_RUN" },
            eventHash: hashEvento(body.loteId, agora),
          },
        });
        json(res, 200, {
          estado,
          aviso:
            estado.resultCode === "ALREADY_CANCELLED"
              ? "Lote histórico já estava CANCELADO — nenhum dado alterado."
              : "Lote histórico CANCELADO. Dados, outbox e auditoria integralmente preservados.",
        });
      } catch (error) {
        const mensagem = error instanceof Error ? error.message : "Falha no cancelamento.";
        const codigo = mensagem.includes("NOT_HISTORICAL_BATCH")
          ? "NOT_HISTORICAL_BATCH"
          : mensagem.includes("MODE_NOT_DRY_RUN")
            ? "MODE_NOT_DRY_RUN"
            : mensagem.includes("OUTBOX_NOT_SETTLED")
              ? "OUTBOX_NOT_SETTLED"
              : mensagem.includes("INVALID_STATE")
                ? "BLOCKED_INVALID_STATE"
                : "BLOCKED_CANCELLATION";
        json(res, 409, { erro: mensagem, codigo });
      }
    },
  },

  // ------------------------------------------------------------------
  // WORKER RUN-ONCE — OPERATOR_ROUTE. F6: DRY_RUN SEMPRE — o corpo da
  // requisição é IGNORADO; nenhum parâmetro do browser escolhe o modo.
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/pilot/worker/run-once",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const readiness = await avaliarReadiness(process.env, () => sondarDatabase(process.env));
      const veredito = workerPodeExecutar(readiness);
      if (!veredito.ok) {
        json(res, 409, { erro: `Worker bloqueado: ${veredito.motivo}`, codigo: veredito.motivo });
        return;
      }
      // F6: dryRun=true HARDCODED server-side. Não há caminho de request
      // para o envio real — executarWorkerUmaVezLive não é exposto aqui.
      // (O LIVE controlado vive exclusivamente em /api/pilot/controlled/execute,
      // com pré-voo próprio e gates GATE 1/2 + modo controlado por comunicação.)
      const resultado = await executarWorkerUmaVez({ env: process.env });
      json(res, 200, {
        modo: resultado.resultado?.modo ?? "DRY_RUN",
        resultado: resultado.resultado,
        motivo: resultado.motivo,
        aviso:
          "Execução one-shot server-side, SEMPRE DRY_RUN nesta rota. Envio real exige mecanismo separado e gates humanos.",
      });
    },
  },

  // ------------------------------------------------------------------
  // F12 — SESSÃO OPERACIONAL: troca única do OPERATOR_TOKEN por sessão de
  // curta duração (cookie HttpOnly). Comparação em tempo constante; fail-closed
  // sem env; token bruto nunca vai ao browser, storage, URL ou log. Depois da
  // sessão, as OPERATOR_ROUTE aceitam o cookie (Bearer preservado p/ CLI).
  // ------------------------------------------------------------------
  {
    metodo: "POST",
    caminhoExato: "/api/operator/session",
    handler: async (_req, res, _url, corpo) => {
      const esperado = process.env.OPERATOR_TOKEN?.trim();
      if (!esperado) {
        json(res, 503, {
          erro: "OPERATOR_TOKEN não configurado no ambiente — autenticação operacional indisponível (fail-closed).",
          codigo: "OPERATOR_TOKEN_MISSING",
        });
        return;
      }
      let token = "";
      try {
        const body = JSON.parse(corpo.toString("utf8") || "{}") as { token?: unknown };
        if (typeof body.token === "string") token = body.token;
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      const a = Buffer.from(token);
      const b = Buffer.from(esperado);
      if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) {
        json(res, 401, { erro: "Token operacional inválido.", codigo: "OPERATOR_AUTH_INVALID" });
        return;
      }
      const { cookie, expiraEm } = criarSessaoOperador();
      json(
        res,
        200,
        { status: "OPERATOR_SESSION_ACTIVE", expiraEm: new Date(expiraEm).toISOString() },
        { "set-cookie": cookie },
      );
    },
  },
  {
    metodo: "DELETE",
    caminhoExato: "/api/operator/session",
    handler: async (req, res) => {
      // F16: sessão stateless — logout apenas limpa o cookie no browser
      // (a validação continua fail-closed server-side em qualquer instância).
      json(res, 200, { status: "OPERATOR_SESSION_CLOSED" }, { "set-cookie": sessaoCookieRemovido() });
    },
  },
  // ------------------------------------------------------------------
  // F17 — Restore da sessão operacional pela UI (consultaSessao na
  // inicialização). Resposta sanitizada: NUNCA token, assinatura, nonce ou
  // valor do cookie — apenas status + expiração.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/operator/session",
    handler: async (req, res) => {
      const cookie = cookiesDo(req)[OPERATOR_SESSION_COOKIE];
      if (!sessaoOperadorValida(cookie)) {
        json(res, 401, {
          erro: "Sessão operacional ausente, inválida ou expirada.",
          codigo: "OPERATOR_AUTH_REQUIRED",
        });
        return;
      }
      json(res, 200, {
        status: "OPERATOR_SESSION_ACTIVE",
        expiraEm: expiracaoDaSessao(cookie),
      });
    },
  },

  // ------------------------------------------------------------------
  // F2/F12/F13 — OAuth Gmail. start e status são OPERATOR_ROUTE; o callback
  // é público porém protegido pelo binding one-time start↔callback (state
  // assinado + nonce + cookie HttpOnly). Nenhum secret devolvido ao browser.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/oauth/gmail/status",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      const config = loadGmailOauthConfig(process.env);
      let connected = false;
      if (config && process.env.DATABASE_URL?.trim() && process.env.DATA_ENCRYPTION_KEY_BASE64?.trim()) {
        try {
          connected = await requireDb().repository.existeConexaoGmailAtiva();
        } catch {
          connected = false;
        }
      }
      json(res, 200, {
        status: oauthStatusFromEnvironment(process.env, connected),
        escopo: "https://www.googleapis.com/auth/gmail.send",
        // Estados do painel: a UI NUNCA recebe segredo, token ou e-mail.
        contaEsperadaConfigurada: contaGmailEsperada().length > 0,
        hdOrganizacionalConfigurado: hdOrganizacionalEsperado().length > 0,
        realSendEnabled: process.env.REAL_SEND_ENABLED === "true",
        controlledMode: process.env.GMAIL_CONTROLLED_MODE === "true",
        // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — SIM/NÃO, sem valor sensível.
        providerGmailConfigurado: carregarPoliticaProvider().providerGmailConfigurado,
        mensagem:
          config === undefined
            ? "Credenciais OAuth ausentes no ambiente. O titular configura GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI — nunca via chat."
            : connected
              ? "Conta conectada (tokens persistidos cifrados)."
              : "Conexão real é realizada pelo titular no fluxo OAuth (gate humano).",
      });
    },
  },
  {
    metodo: "DELETE",
    caminhoExato: "/api/oauth/gmail/connection",
    handler: async (req, res) => {
      if (!exigirOperador(req, res)) return;
      if (!process.env.DATABASE_URL?.trim()) {
        json(res, 503, { erro: "Persistência não configurada — desconexão indisponível.", codigo: "DB_NOT_CONFIGURED" });
        return;
      }
      try {
        const { repository } = requireDb();
        // Ação explícita e auditada (OAUTH_GMAIL_DISCONNECTED). A revogação
        // EXTERNA no Google NUNCA é executada automaticamente (política do
        // piloto) — apenas o estado local é marcado como revogado.
        const revogadas = await repository.revogarConexoesGmail({
          operador: "operador-sessao",
          occurredAt: new Date().toISOString(),
        });
        json(res, 200, { status: "DISCONNECTED", revogadas });
      } catch {
        json(res, 500, { erro: "Falha ao desconectar a conta." });
      }
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/oauth/gmail/start",
    handler: async (req, res, url) => {
      if (!exigirOperador(req, res)) return;
      try {
        const origin = process.env.CONFIRMATION_BASE_URL?.trim() || `${url.protocol}//${url.host}`;
        // F18 + closure item 1: binding one-time registrado em PostgreSQL —
        // START em qualquer instância é consumível pelo CALLBACK em qualquer
        // outra. O verifier PKCE fica CIFRADO no banco; o hash do operador
        // ancora a sessão no cookie HttpOnly (nunca o token).
        const tokenOperador = process.env.OPERATOR_TOKEN?.trim() ?? "";
        if (!tokenOperador) {
          throw new OauthFlowError("OPERATOR_TOKEN_MISSING", "OPERATOR_TOKEN ausente.");
        }
        const operadorHash = hashOperadorGmail(tokenOperador);
        const { repository } = requireDb();
        const { url: consentUrl, expiresAt, bindingNonce } = await iniciarFluxoOauth(
          origin,
          repository,
          new Date(),
          { caixa: caixa(), operadorHash },
        );
        // F13: cookie HttpOnly do fluxo com <nonce>:<operadorHash> — consumido
        // one-time pelo callback; nenhum secret no cookie, URL ou log.
        json(
          res,
          200,
          { authorizationUrl: consentUrl, expiresAt },
          { "set-cookie": bindingCookie(`${bindingNonce}:${operadorHash}`) },
        );
      } catch (error) {
        if (error instanceof OauthFlowError) {
          json(res, 409, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 500, { erro: "Falha ao iniciar o fluxo OAuth." });
      }
    },
  },
  {
    metodo: "GET",
    caminhoExato: "/api/oauth/gmail/callback",
    handler: async (req, res, url) => {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code || !state) {
        json(res, 400, { erro: "code/state ausentes.", codigo: "CALLBACK_INVALID" });
        return;
      }
      try {
        const { repository } = requireDb();
        const binding = cookiesDo(req)[OAUTH_BINDING_COOKIE];
        // F18: o binding vive em PostgreSQL (serverless-safe); hash do nonce
        // é calculado server-side — o valor bruto nunca é persistido.
        const resultado = await concluirFluxoOauth(
          code,
          state,
          binding,
          repository,
          caixa(),
          fingerprinter(),
        );
        // Auditoria já registrada no repositório. NUNCA devolvemos tokens.
        json(
          res,
          200,
          { status: resultado.status, escopo: resultado.scopes[0] },
          { "set-cookie": bindingCookieRemovido() },
        );
      } catch (error) {
        if (error instanceof OauthFlowError) {
          json(res, 401, { erro: error.message, codigo: error.codigo });
          return;
        }
        json(res, 500, { erro: "Falha ao concluir o fluxo OAuth." });
      }
    },
  },

  // ------------------------------------------------------------------
  // F5 — PUBLIC_CONFIRMATION_ROUTE (capability token na URL).
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    caminhoExato: "/api/confirmation",
    handler: async (_req, res, url) => {
      const token = url.searchParams.get("token") ?? "";
      if (!token) {
        json(res, 400, { erro: "token ausente." });
        return;
      }
      const tokens = createWebTokenService();
      const tokenHash = await tokens.hash(token);
      try {
        const { repository } = requireDb();
        const contexto = await repository.obterContextoConfirmacao(
          tokenHash,
          caixa(),
          new Date().toISOString(),
        );
        if (!contexto) {
          json(res, 404, { erro: "Confirmação não encontrada, expirada ou já utilizada." });
          return;
        }
        json(res, 200, contexto);
      } catch {
        json(res, 503, { erro: "Serviço de confirmação indisponível." });
      }
    },
  },
  {
    metodo: "POST",
    caminhoExato: "/api/confirmation",
    handler: async (_req, res, url, corpo) => {
      const token = url.searchParams.get("token") ?? "";
      if (!token) {
        json(res, 400, { erro: "token ausente." });
        return;
      }
      let input: ConfirmationDecisionInput;
      try {
        input = JSON.parse(corpo.toString("utf8") || "{}") as ConfirmationDecisionInput;
      } catch {
        json(res, 400, { erro: "JSON inválido." });
        return;
      }
      if (input.decision !== "CONFIRMAR" && input.decision !== "ATUALIZAR") {
        json(res, 422, { erro: "decision deve ser CONFIRMAR ou ATUALIZAR." });
        return;
      }
      const validacao = validarDadosPropostos(input);
      if (!validacao.ok) {
        json(res, 422, { erro: "Dados inválidos.", issues: validacao.issues });
        return;
      }
      try {
        const { pool, repository } = requireDb();
        const ownership = new PostgresConfirmationOwnership(pool);
        const resultado = await concluirConfirmacao(token, input, ownership, repository, caixa());
        json(res, 200, resultado);
      } catch (error) {
        if (error instanceof ConfirmationInvalidaError) {
          json(res, 409, { erro: "Confirmação inválida, expirada ou já utilizada.", codigo: error.codigo });
          return;
        }
        json(res, 503, { erro: "Serviço de confirmação indisponível." });
      }
    },
  },
];

/**
 * F15 — Matching EXATO de caminhos: estáticas por igualdade completa;
 * dinâmicas (ex.: /confirma/:token) apenas por matcher explícito e restrito.
 * Nenhum match por prefixo — /api/health-foo NUNCA resolve para /api/health.
 */
function correspondeCaminho(rota: Rota, pathname: string): boolean {
  if (rota.caminhoExato !== undefined) return pathname === rota.caminhoExato;
  return rota.matcher ? rota.matcher(pathname) : false;
}

export function criarServidor() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    try {
      const rota = ROTAS.find(
        (r) => r.metodo === req.method && correspondeCaminho(r, url.pathname),
      );
      if (!rota) {
        json(res, 404, { erro: "Rota não encontrada." });
        return;
      }
      // F10: público explícito; todo o resto exige operador autenticado.
      const routeKey = `${req.method} ${rota.caminhoExato ?? ""}`;
      const publica = ROTAS_PUBLICAS.has(routeKey);
      const authPropria = ROTAS_AUTH_PROPRIA.has(routeKey);
      if (!publica && !authPropria && !exigirOperador(req, res)) return;
      const corpo = req.method === "POST" ? await lerCorpo(req) : Buffer.alloc(0);
      await rota.handler(req, res, url, corpo);
    } catch (error) {
      // Erro sanitizado: nunca ecoa payload, DSN ou PII.
      const mensagem = error instanceof Error ? error.message : "Erro interno.";
      json(res, 500, { erro: mensagem.slice(0, 200) });
    }
  });
}

// ---------------------------------------------------------------------------
// F1 — Despacho headless: MESMAS ROTAS, MESMA autenticação, MESMA lógica do
// servidor Node — reutilizado pelo adapter serverless (api/index.ts) para
// provar backend operacional no Preview sem duplicar nenhuma regra.
// ---------------------------------------------------------------------------

interface DespachoResultado {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly corpo: string;
}

function respostaColetada() {
  let status = 200;
  let headers: Record<string, string> = {};
  let corpo = "";
  const res = {
    writeHead(codigo: number, cabecalhos: Record<string, string>) {
      status = codigo;
      // set-cookie pode ocorrer múltiplas vezes (RFC 6265): acumula em lista
      // separada por "\n" para não perder cookies (ex.: binding + sessão).
      for (const [nome, valor] of Object.entries(cabecalhos)) {
        headers[nome] = nome === "set-cookie" && headers[nome]
          ? `${headers[nome]}\n${valor}`
          : valor;
      }
    },
    end(payload?: string) {
      corpo = payload ?? "";
    },
  };
  return {
    res,
    obter(): DespachoResultado {
      return { status, headers, corpo };
    },
  };
}

export async function despachar(
  metodo: string,
  caminho: string,
  opcoes: { headers?: Record<string, string | undefined>; corpo?: Buffer } = {},
): Promise<DespachoResultado> {
  const url = new URL(caminho, `http://localhost:${PORT}`);
  const coletor = respostaColetada();
  const headers = opcoes.headers ?? {};
  const req = {
    method: metodo,
    headers,
    async *[Symbol.asyncIterator]() {
      if (opcoes.corpo?.length) yield opcoes.corpo;
    },
  } as unknown as IncomingMessage;
  try {
    const rota = ROTAS.find(
      (r) => r.metodo === metodo && correspondeCaminho(r, url.pathname),
    );
    if (!rota) {
      json(coletor.res as unknown as ServerResponse, 404, { erro: "Rota não encontrada." });
      return coletor.obter();
    }
    const routeKey = `${metodo} ${rota.caminhoExato ?? ""}`;
    const publica = ROTAS_PUBLICAS.has(routeKey);
    const authPropria = ROTAS_AUTH_PROPRIA.has(routeKey);
    if (!publica && !authPropria && !exigirOperador(req, coletor.res as unknown as ServerResponse)) {
      return coletor.obter();
    }
    const corpo = metodo === "POST" ? await lerCorpo(req) : Buffer.alloc(0);
    await rota.handler(req, coletor.res as unknown as ServerResponse, url, corpo);
  } catch (error) {
    const mensagem = error instanceof Error ? error.message : "Erro interno.";
    json(coletor.res as unknown as ServerResponse, 500, { erro: mensagem.slice(0, 200) });
  }
  return coletor.obter();
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  criarServidor().listen(PORT, "0.0.0.0", () => {
    console.log(`integra-correios API escutando em 0.0.0.0:${PORT}`);
  });
}
