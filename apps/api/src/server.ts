import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
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
 * OPERATOR_ROUTE: rotas operacionais (importar, cockpit, lote, worker,
 *   readiness detalhado). Exigem cabeçalho Authorization: Bearer
 *   OPERATOR_TOKEN — segredo do ambiente (fail-closed: sem o segredo no
 *   ambiente, NENHUMA rota operacional responde; nenhum XLSX real entra).
 * PUBLIC_CONFIRMATION_ROUTE: consulta/submissão da confirmação do
 *   profissional — protegida pelo capability token na URL (256 bits,
 *   hash-only no banco, consumo atômico). Nunca expõe PII além do
 *   contexto mínimo.
 * /api/health é público sem PII (readiness simples de uptime).
 */

const ROTAS_PUBLICAS = new Set([
  "GET /api/health",
  "GET /api/confirmation", // consulta por token (capability)
  "POST /api/confirmation", // submissão por token (capability)
  "GET /api/oauth/gmail/start", // redireciona ao consentimento Google (gate humano do titular)
  "GET /api/oauth/gmail/callback", // callback autorizado pelo titular
  "GET /api/oauth/gmail/status", // estado sem secrets
]);

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

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
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

/** Comparação em tempo constante do token do operador (F10). */
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

type RotaHandler = (req: IncomingMessage, res: ServerResponse, url: URL, corpo: Buffer) => Promise<void>;

interface Rota {
  metodo: string;
  prefixo: string;
  handler: RotaHandler;
}

function exigirOperador(req: IncomingMessage, res: ServerResponse): boolean {
  if (verificarOperador(req)) return true;
  json(res, 401, { erro: "Acesso do operador exigido (Authorization: Bearer OPERATOR_TOKEN)." });
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
    prefixo: "/api/health",
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
    prefixo: "/api/readiness",
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
    prefixo: "/api/intake/analyze",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const nome = req.headers["x-file-name"]?.toString() ?? "entrada.xlsx";
      const folha = req.headers["x-sheet-name"]?.toString();
      const linhaCabecalho = req.headers["x-header-row"]?.toString();
      const analise = analisarXlsx(
        nome,
        new Uint8Array(corpo),
        folha,
        linhaCabecalho ? Number.parseInt(linhaCabecalho, 10) : undefined,
      );
      json(res, 200, analise);
    },
  },
  {
    metodo: "POST",
    prefixo: "/api/intake/preflight",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const nome = req.headers["x-file-name"]?.toString() ?? "entrada.xlsx";
      const folha = req.headers["x-sheet-name"]?.toString();
      const linhaCabecalho = req.headers["x-header-row"]?.toString();
      const mapeamento = JSON.parse(req.headers["x-mapping"]?.toString() ?? "[]");
      const input: PreflightInput = {
        nomeArquivo: nome,
        bytes: new Uint8Array(corpo),
        ...(folha ? { folha } : {}),
        ...(linhaCabecalho ? { linhaCabecalho: Number.parseInt(linhaCabecalho, 10) } : {}),
        mapeamento,
      };
      json(res, 200, executarPreflight(input));
    },
  },
  {
    metodo: "POST",
    prefixo: "/api/intake/confirm",
    handler: async (req, res, _url, corpo) => {
      if (!exigirOperador(req, res)) return;
      const { pool, repository } = requireDb();
      const nome = req.headers["x-file-name"]?.toString() ?? "entrada.xlsx";
      const folha = req.headers["x-sheet-name"]?.toString();
      const linhaCabecalho = req.headers["x-header-row"]?.toString();
      const mapeamento = JSON.parse(req.headers["x-mapping"]?.toString() ?? "[]");
      const resultado = await confirmarImportacao(
        {
          nomeArquivo: nome,
          bytes: new Uint8Array(corpo),
          ...(folha ? { folha } : {}),
          ...(linhaCabecalho ? { linhaCabecalho: Number.parseInt(linhaCabecalho, 10) } : {}),
          mapeamento,
          operador: "operador-autenticado",
        },
        repository,
      );
      json(res, 200, resultado);
    },
  },

  // ------------------------------------------------------------------
  // COCKPIT / PILOTO — OPERATOR_ROUTE.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    prefixo: "/api/professionals",
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
    prefixo: "/api/pilot/preview",
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
    prefixo: "/api/pilot/prepare",
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
    prefixo: "/api/pilot/outbox",
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
    prefixo: "/api/pilot/activate",
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
    prefixo: "/api/pilot/worker/run-once",
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
  // F2 — OAuth Gmail: start (URL de consentimento) e callback (troca,
  // cifragem e persistência). Rotas de gate humano do titular.
  // ------------------------------------------------------------------
  {
    metodo: "GET",
    prefixo: "/api/oauth/gmail/status",
    handler: async (_req, res) => {
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
    prefixo: "/api/oauth/gmail/start",
    handler: async (_req, res, url) => {
      try {
        const origin = process.env.CONFIRMATION_BASE_URL?.trim() || `${url.protocol}//${url.host}`;
        const { url: consentUrl, expiresAt } = iniciarFluxoOauth(origin);
        json(res, 200, { authorizationUrl: consentUrl, expiresAt });
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
    prefixo: "/api/oauth/gmail/callback",
    handler: async (_req, res, url) => {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code || !state) {
        json(res, 400, { erro: "code/state ausentes.", codigo: "CALLBACK_INVALID" });
        return;
      }
      try {
        const { pool, repository } = requireDb();
        const resultado = await concluirFluxoOauth(code, state, repository, caixa(), fingerprinter());
        // Auditoria já registrada no repositório. NUNCA devolvemos tokens.
        json(res, 200, { status: resultado.status, escopo: resultado.scopes[0] });
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
    prefixo: "/api/confirmation",
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
    prefixo: "/api/confirmation",
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

export function criarServidor() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    try {
      const rota = ROTAS.find(
        (r) => r.metodo === req.method && url.pathname.startsWith(r.prefixo),
      );
      if (!rota) {
        json(res, 404, { erro: "Rota não encontrada." });
        return;
      }
      // F10: público explícito; todo o resto exige operador autenticado.
      const publica = ROTAS_PUBLICAS.has(`${req.method} ${rota.prefixo}`);
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
      headers = { ...cabecalhos };
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
      (r) => r.metodo === metodo && url.pathname.startsWith(r.prefixo),
    );
    if (!rota) {
      json(coletor.res as unknown as ServerResponse, 404, { erro: "Rota não encontrada." });
      return coletor.obter();
    }
    const publica = ROTAS_PUBLICAS.has(`${metodo} ${rota.prefixo}`);
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
