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
import { createHmac, randomBytes } from "node:crypto";

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
