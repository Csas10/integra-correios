import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  NodePostgresPool,
  PostgresOperationalRepository,
  PostgresConfirmationOwnership,
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
} from "@integra-correios/persistence";
import {
  analisarXlsx,
  confirmarImportacao,
  executarPreflight,
  type PreflightInput,
} from "./intake.js";
import {
  carregarPilotPolicy,
  gerarPreviewComunicacao,
  listarProfissionais,
  prepararLotePiloto,
  statusOutbox,
  type FiltroCockpit,
} from "./pilot.js";
import {
  iniciarFluxoOauth,
  concluirFluxoOauth,
  OauthFlowError,
  oauthConfigurado,
} from "./oauth.js";
import {
  concluirConfirmacao,
  validarDadosPropostos,
  ConfirmationInvalidaError,
  type ConfirmationDecisionInput,
} from "./confirmation.js";
import { createWebTokenService } from "@integra-correios/pf-workflow";
import {
  loadGmailOauthConfig,
  oauthStatusFromEnvironment,
  OAUTH_BINDING_COOKIE,
} from "@integra-correios/mail";
import {
  avaliarReadiness,
  workerPodeExecutar,
  sondarDatabase,
  executarWorkerUmaVez,
} from "@integra-correios/worker";

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
  "DELETE /api/operator/session", // logout operacional
]);

const OPERATOR_SESSION_COOKIE = "ic_operator_session";

/** F12 — TTL da sessão operacional (cookie HttpOnly; token NUNCA vai ao browser). */
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** F13 — TTL curto do binding one-time do fluxo OAuth. */
const OAUTH_BINDING_TTL_SECONDS = 600;

/**
 * Sessões operacionais em memória do processo (F12): o cookie carrega um
 * identificador opaco aleatório — NUNCA o OPERATOR_TOKEN. Instância por
 * processo; em serverless multi-instância a sessão deve migrar a um store
 * compartilhado (limitação documentada na PR).
 */
const sessoesOperador = new Map<string, { expiraEm: number }>();

function limparSessoesExpiradas(): void {
  const agora = Date.now();
  for (const [id, sessao] of sessoesOperador) {
    if (sessao.expiraEm <= agora) sessoesOperador.delete(id);
  }
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

/**
 * F12 — Cria sessão operacional de curta duração: id opaco aleatório gravado
 * no cookie HttpOnly; o mapeamento id→expiração vive apenas na memória do
 * processo. O token bruto NUNCA vai ao browser/storage/URL/log.
 */
function criarSessaoOperador(): { cookie: string; expiraEm: number } {
  const id = randomBytes(32).toString("base64url");
  const expiraEm = Date.now() + OPERATOR_SESSION_TTL_MS;
  sessoesOperador.set(id, { expiraEm });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    cookie: `${OPERATOR_SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.floor(OPERATOR_SESSION_TTL_MS / 1000)}`,
    expiraEm,
  };
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

function autenticacaoDeSessao(req: IncomingMessage): boolean {
  const cookie = cookiesDo(req)[OPERATOR_SESSION_COOKIE];
  if (!cookie) return false;
  limparSessoesExpiradas();
  const sessao = sessoesOperador.get(cookie);
  if (!sessao || sessao.expiraEm <= Date.now()) {
    sessoesOperador.delete(cookie);
    return false;
  }
  return true;
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
        json(res, 422, { erro: error instanceof Error ? error.message : "Falha na preparação do lote." });
      }
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
      const cookie = cookiesDo(req)[OPERATOR_SESSION_COOKIE];
      if (cookie) sessoesOperador.delete(cookie);
      json(res, 200, { status: "OPERATOR_SESSION_CLOSED" }, { "set-cookie": sessaoCookieRemovido() });
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
    metodo: "GET",
    caminhoExato: "/api/oauth/gmail/start",
    handler: async (req, res, url) => {
      if (!exigirOperador(req, res)) return;
      try {
        const origin = process.env.CONFIRMATION_BASE_URL?.trim() || `${url.protocol}//${url.host}`;
        const { url: consentUrl, expiresAt, bindingNonce } = iniciarFluxoOauth(origin);
        // F13: nonce de binding no cookie HttpOnly do fluxo — consumido
        // one-time pelo callback; nenhum secret na URL além do state OAuth.
        json(
          res,
          200,
          { authorizationUrl: consentUrl, expiresAt },
          { "set-cookie": bindingCookie(bindingNonce) },
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
        const { pool, repository } = requireDb();
        const binding = cookiesDo(req)[OAUTH_BINDING_COOKIE];
        const resultado = await concluirFluxoOauth(code, state, binding, repository, caixa(), fingerprinter());
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
      const publica = ROTAS_PUBLICAS.has(`${req.method} ${rota.caminhoExato ?? ""}`);
      if (!publica && !exigirOperador(req, res)) return;
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
    const publica = ROTAS_PUBLICAS.has(`${metodo} ${rota.caminhoExato ?? ""}`);
    if (!publica && !exigirOperador(req, coletor.res as unknown as ServerResponse)) {
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
