import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NodePostgresPool, PostgresOperationalRepository, Aes256GcmSecretBox, HmacSha256Fingerprinter } from "@integra-correios/persistence";
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
import { createWebTokenService } from "@integra-correios/pf-workflow";
import {
  loadGmailOauthConfig,
  oauthStatusFromEnvironment,
} from "@integra-correios/mail";
import { avaliarReadiness, workerPodeExecutar, sondarDatabase, executarWorkerUmaVez } from "@integra-correios/worker";
import { randomUUID, createHmac } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

interface Contexto {
  pool?: NodePostgresPool;
  repository?: PostgresOperationalRepository;
}

const contexto: Contexto = {};

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

function requireDb(): { pool: NodePostgresPool; repository: PostgresOperationalRepository } {
  if (!contexto.pool) {
    contexto.pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL });
    contexto.repository = new PostgresOperationalRepository(contexto.pool);
  }
  return { pool: contexto.pool, repository: contexto.repository! };
}

type RotaHandler = (req: IncomingMessage, res: ServerResponse, url: URL, corpo: Buffer) => Promise<void>;

const ROTAS: readonly { metodo: string; prefixo: string; handler: RotaHandler; body?: boolean }[] = [
  { metodo: "GET", prefixo: "/api/health", handler: async (_req, res) => {
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
  }},

  { metodo: "POST", prefixo: "/api/intake/analyze", handler: async (_req, res, _url, corpo) => {
    const nome = _req.headers["x-file-name"]?.toString() ?? "entrada.xlsx";
    const folha = _req.headers["x-sheet-name"]?.toString();
    const linhaCabecalho = _req.headers["x-header-row"]?.toString();
    const analise = analisarXlsx(
      nome,
      new Uint8Array(corpo),
      folha,
      linhaCabecalho ? Number.parseInt(linhaCabecalho, 10) : undefined,
    );
    json(res, 200, analise);
  }},

  { metodo: "POST", prefixo: "/api/intake/preflight", handler: async (req, res, _url, corpo) => {
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
  }},

  { metodo: "POST", prefixo: "/api/intake/confirm", handler: async (req, res, _url, corpo) => {
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
        operador: req.headers["x-operator"]?.toString() ?? "operador-preview",
      },
      repository,
      pool,
    );
    json(res, 200, resultado);
  }},

  { metodo: "GET", prefixo: "/api/professionals", handler: async (_req, res, url) => {
    const { pool } = requireDb();
    const filtro = (url.searchParams.get("filtro") ?? "TODOS") as FiltroCockpit;
    const profissionais = await listarProfissionais(pool, filtro, caixa());
    json(res, 200, { profissionais });
  }},

  { metodo: "POST", prefixo: "/api/pilot/preview", handler: async (_req, res, _url, corpo) => {
    const { pool } = requireDb();
    const selecao = JSON.parse(corpo.toString("utf8")) as { professionalIds: string[] };
    const policy = carregarPilotPolicy();
    if (selecao.professionalIds.length > policy.maxRecipients) {
      json(res, 422, { erro: `Seleção de ${selecao.professionalIds.length} excede o limite do piloto (${policy.maxRecipients}).` });
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
  }},

  { metodo: "POST", prefixo: "/api/pilot/prepare", handler: async (_req, res, _url, corpo) => {
    const { pool, repository } = requireDb();
    const selecao = JSON.parse(corpo.toString("utf8")) as { professionalIds: string[]; operador?: string };
    const policy = carregarPilotPolicy();
    const tokens = createWebTokenService();
    try {
      const resultado = await prepararLotePiloto(
        {
          professionalIds: selecao.professionalIds,
          operador: selecao.operador ?? "operador-preview",
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
  }},

  { metodo: "GET", prefixo: "/api/pilot/outbox", handler: async (_req, res, url) => {
    const { pool } = requireDb();
    const loteId = url.searchParams.get("loteId") ?? undefined;
    json(res, 200, { itens: await statusOutbox(pool, loteId) });
  }},

  // ------------------------------------------------------------------
  // Readiness operacional — estados por subsistema, SEM secrets.
  // ------------------------------------------------------------------
  { metodo: "GET", prefixo: "/api/readiness", handler: async (_req, res) => {
    const report = await avaliarReadiness(process.env, () => sondarDatabase(process.env));
    json(res, 200, report);
  }},

  // ------------------------------------------------------------------
  // LIBERAÇÃO DE LOTE (GATE 2) — ação humana deliberada e auditável:
  // CAS PREPARACAO → ATIVO + hard cap revalidado server-side.
  // O browser não define nada além do loteId e do ator declarado.
  // ------------------------------------------------------------------
  { metodo: "POST", prefixo: "/api/pilot/activate", handler: async (_req, res, _url, corpo) => {
    const { pool, repository } = requireDb();
    const body = JSON.parse(corpo.toString("utf8")) as { loteId?: string; operador?: string };
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
    try {
      const resultado = await repository.ativarLoteComunicacao({
        batchId: body.loteId,
        origin: "PF",
        actorId: body.operador ?? "operador-preview",
        activatedAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: body.loteId,
          type: "PF_LOTE_COMUNICACAO_ATIVADO",
          actorId: body.operador ?? "operador-preview",
          occurredAt: agora,
          metadata: { totalItens: total },
          eventHash: hashEvento(body.loteId, agora),
        },
      });
      json(res, 200, { resultado, modoEnvio: "DISABLED", aviso: "Lote ATIVO para DRY_RUN. Envio real permanece bloqueado (REAL_SEND_ENABLED=false)." });
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
  }},

  // ------------------------------------------------------------------
  // WORKER RUN-ONCE — execução controlada de UMA iteração server-side
  // (mesmo serviço interno do CLI). DRY_RUN por padrão; envio externo
  // permanece duplamente bloqueado (GATE 1 + GATE 2 + flag do chamador).
  // ------------------------------------------------------------------
  { metodo: "POST", prefixo: "/api/pilot/worker/run-once", handler: async (_req, res, _url, corpo) => {
    const body = JSON.parse(corpo.toString("utf8") || "{}") as { dryRun?: boolean };
    const readiness = await avaliarReadiness(process.env, () => sondarDatabase(process.env));
    const veredito = workerPodeExecutar(readiness);
    if (!veredito.ok) {
      json(res, 409, { erro: `Worker bloqueado: ${veredito.motivo}`, codigo: veredito.motivo });
      return;
    }
    // LIVE (dryRun=false) é recusado nesta fase: envio real só via gate humano
    // explícito fora da UI (REAL_SEND_ENABLED + liberação formal).
    const resultado = await executarWorkerUmaVez({ dryRun: body.dryRun !== false, env: process.env });
    json(res, 200, {
      modo: resultado.resultado?.modo ?? "DRY_RUN",
      resultado: resultado.resultado,
      motivo: resultado.motivo,
      aviso: "Execução one-shot server-side. DRY_RUN usa gateway sintético — nenhuma mensagem externa.",
    });
  }},

  { metodo: "GET", prefixo: "/api/oauth/gmail/status", handler: async (_req, res) => {
    const config = loadGmailOauthConfig(process.env);
    const status = oauthStatusFromEnvironment(process.env, false);
    json(res, 200, {
      status,
      escopo: "https://www.googleapis.com/auth/gmail.send",
      mensagem:
        status === "CONFIGURATION_REQUIRED"
          ? "Credenciais OAuth ausentes no ambiente. O titular configura GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI — nunca via chat."
          : "Conexão real será realizada pelo titular em gate humano separado.",
    });
  }},
]

function hashEvento(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}

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
      const corpo = req.method === "POST" ? await lerCorpo(req) : Buffer.alloc(0);
      await rota.handler(req, res, url, corpo);
    } catch (error) {
      // Erro sanitizado: nunca ecoa payload, DSN ou PII.
      const mensagem = error instanceof Error ? error.message : "Erro interno.";
      json(res, 500, { erro: mensagem.slice(0, 200) });
    }
  });
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  criarServidor().listen(PORT, "0.0.0.0", () => {
    console.log(`integra-correios API escutando em 0.0.0.0:${PORT}`);
  });
}
