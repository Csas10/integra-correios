import {
  DisabledMailGateway,
  DryRunMailGateway,
  GmailHttpTransport,
  GmailMailGateway,
  derivarFingerprintContaGmail,
  loadGmailOauthConfig,
  type MailGateway,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import {
  NodePostgresPool,
  PostgresOperationalRepository,
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  type ClaimedOutboxItem,
  type GmailOauthCredentialSource,
} from "@integra-correios/persistence";
import {
  GmailAmbiguousError,
  GmailAuthError,
  GmailPermanentPolicyError,
  GmailRateLimitError,
} from "@integra-correios/mail";
import { avaliarReadiness, providerGmailConfigurado, workerPodeExecutar, type ReadinessReport } from "./readiness.js";

/**
 * Worker da outbox — MOTOR ÚNICO para DRY_RUN e LIVE_PILOT.
 *
 * EXECUTION MODES (um só pipeline; muda apenas o MailGateway e os gates):
 *   DRY_RUN    → gateway SINTÉTICO: valida o encadeamento completo
 *                (claim → render → send fake → receipt → auditoria) sem
 *                nenhuma chamada externa;
 *   LIVE_PILOT → GmailMailGateway REAL: exige GATE 1 (REAL_SEND_ENABLED=true)
 *                E GATE 2 (lote_comunicacao.status = ATIVO, liberado por
 *                ativarLoteComunicacao com CAS + auditoria).
 *
 * O claim já garante GATE 2 no SQL (JOIN lote status = 'ATIVO'); o gateway
 * garante GATE 1. Nenhum dos dois, sozinho, libera envio externo.
 *
 * Entrypoints:
 *  - executarWorkerUmaVez(): função pura de serviço, usada pela API
 *    (run-once controlado server-side para o Preview/DRY_RUN) e pelo CLI;
 *  - CLI (`node apps/worker/dist/outbox.js`): uma iteração por invocação.
 *    Sem loop infinito — o piloto é one-time e supervisionado.
 */

export const MAX_TENTATIVAS = 3;

export interface WorkerResult {
  readonly processados: number;
  readonly enviados: number;
  readonly falhas: number;
  readonly codigosErro: readonly string[];
  readonly modo: "DRY_RUN" | "LIVE_PILOT";
}

// F7: o gateway sintético agora vive em @integra-correios/mail com provider
// explícito "DRY_RUN" — nenhum registro persistido pode ser lido como Gmail real.

/** (Exportada para testes — construção determinística da mensagem.) */
export function mailFromPayload(payload: any): OutboundMail {
  const base = new URL(payload.confirmationBaseUrl);
  const confirmUrl = new URL(`/confirma/${encodeURIComponent(payload.plainToken)}`, base).toString();
  // Seção 6: conteúdo HTML é SEMPRE escapado — nome, endereço e telefone vêm
  // do XLSX institucional e nunca podem injetar marcação no template.
  const nomeSeguro = escapeHtml(String(payload.nome ?? ""));
  const enderecoSeguro = escapeHtml(String(payload.enderecoApresentado ?? ""));
  const telefoneSeguro = escapeHtml(String(payload.telefone ?? ""));
  const whatsappSeguro = payload.whatsapp ? escapeHtml(String(payload.whatsapp)) : "";
  // Mesma URL base com decision=ATUALIZAR preservada no token; o form do
  // profissional escolhe CONFIRMAR/ATUALIZAR — uma única URL one-time.
  return {
    idempotencyKey: `pf-pilot:${payload.confirmationId}`,
    confirmationId: payload.confirmationId,
    to: payload.destinatario,
    replyTo: "carteiras@crtba.org.br",
    subject: "Confirmação de dados para envio da Carteira Profissional",
    textBody: [
      `Olá, ${payload.nome}.`,
      "A CRT-BA precisa confirmar seus dados cadastrais antes do envio da sua Carteira Profissional pelos Correios.",
      `Endereço registrado: ${payload.enderecoApresentado}`,
      `Telefone: ${payload.telefone}${payload.whatsapp ? ` | WhatsApp: ${payload.whatsapp}` : ""}`,
      "Confirme ou atualize seus dados no link seguro:",
      confirmUrl,
    ].join("\n"),
    htmlBody: `<p>Olá, <strong>${nomeSeguro}</strong>.</p><p>A CRT-BA precisa confirmar seus dados cadastrais antes do envio da sua Carteira Profissional pelos Correios.</p><p>Endereço registrado: ${enderecoSeguro}</p><p>Telefone: ${telefoneSeguro}${payload.whatsapp ? ` | WhatsApp: ${whatsappSeguro}` : ""}</p><p><a href="${confirmUrl}">CONFIRMAR DADOS / ATUALIZAR DADOS</a></p>`,
    templateVersion: "pf-pilot-crtba-v1",
    // GATE 2 (modo controlado): id da comunicação para a verificação pré-send.
    communicationId: payload.communicationId,
  };
}

export async function processarOutboxUmaVez(
  workerId: string,
  pool: NodePostgresPool,
  gateway: MailGateway,
  caixa: Aes256GcmSecretBox,
  repository: PostgresOperationalRepository,
  now: Date = new Date(),
  /** Modo esperado dos lotes reclamados (F7) — usado pelo chamador autorizado. */
  modoEsperado: "DRY_RUN" | "LIVE_PILOT" = "DRY_RUN",
): Promise<WorkerResult> {
  const items = await repository.claimOutbox(workerId, 10, now.toISOString());
  // F7: o modo do lote é decidido no banco, não pelo gateway. Um lote DRY_RUN
  // reclamado por um motor LIVE seria inconsistência — fail-closed.
  const divergente = items.find((item) => item.modo !== modoEsperado);
  if (divergente) {
    await Promise.all(
      items.map(async (item) =>
        repository.markOutboxFailed({
          outboxId: item.id,
          communicationId: item.communicationId,
          errorCode: "MODE_MISMATCH",
          retryAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
          auditEvent: {
            id: crypto.randomUUID(),
            aggregateType: "COMUNICACAO",
            aggregateId: item.communicationId,
            type: "PF_COMMUNICATION_FAILED",
            occurredAt: now.toISOString(),
            metadata: { codigo: "MODE_MISMATCH", modoLote: item.modo, modoMotor: modoEsperado },
            eventHash: await hashEvento(item.id, "MODE_MISMATCH"),
          },
        }),
      ),
    );
    return { processados: items.length, enviados: 0, falhas: items.length, codigosErro: ["MODE_MISMATCH"], modo: modoEsperado };
  }
  const codigosErro: string[] = [];
  let enviados = 0;
  let falhas = 0;

  for (const item of items as readonly ClaimedOutboxItem[]) {
    // Fase 1 — render: decrypt + parse + validação do payload da outbox.
    // Falha aqui é do ARTEFATO (payload corrompido/inválido), não do provider:
    // código próprio e final (payload não se corrige com retry).
    let message: OutboundMail;
    try {
      const plaintext = caixa.open(item.encryptedPayload, "outbox:email");
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      message = mailFromPayload(payload);
    } catch {
      codigosErro.push("RENDER_PAYLOAD_ERROR");
      await repository.markOutboxFailed({
        outboxId: item.id,
        communicationId: item.communicationId,
        errorCode: "RENDER_PAYLOAD_ERROR",
        retryAt: new Date(now.getTime() + 30 * 24 * 3_600_000).toISOString(),
        auditEvent: {
          id: crypto.randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: item.communicationId,
          type: "PF_COMMUNICATION_FAILED",
          occurredAt: now.toISOString(),
          metadata: { codigo: "RENDER_PAYLOAD_ERROR", final: true },
          eventHash: await hashEvento(item.id, "RENDER_PAYLOAD_ERROR"),
        },
      });
      falhas += 1;
      continue;
    }
    // Fase 2 — envio: erros do gateway/provider com códigos sanitizados.
    try {
      const receipt = await gateway.send(message);
      await repository.markOutboxAccepted({
        outboxId: item.id,
        communicationId: item.communicationId,
        provider: receipt.provider === "MICROSOFT_GRAPH" ? "GMAIL" : receipt.provider,
        providerMessageId: receipt.messageId,
        // F4: threadId do Gmail propagado até comunicacao.provider_thread_id.
        ...(receipt.threadId ? { providerThreadId: receipt.threadId } : {}),
        acceptedAt: receipt.acceptedAt,
        auditEvent: {
          id: crypto.randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: item.communicationId,
          type: "PF_COMMUNICATION_ACCEPTED",
          occurredAt: receipt.acceptedAt,
          metadata: { templateVersion: message.templateVersion },
          eventHash: await hashEvento(item.id, receipt.messageId),
        },
      });
      enviados += 1;
    } catch (error) {
      const codigo = sanitizarErro(error);
      codigosErro.push(codigo);
      const retryAt = calcularRetryAt(codigo, item.attempts, now);
      await repository.markOutboxFailed({
        outboxId: item.id,
        communicationId: item.communicationId,
        errorCode: codigo,
        retryAt: retryAt.toISOString(),
        auditEvent: {
          id: crypto.randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: item.communicationId,
          type: "PF_COMMUNICATION_FAILED",
          occurredAt: now.toISOString(),
          metadata: retryAt.getTime() - now.getTime() >= 30 * 24 * 3_600_000
            ? { codigo, final: true }
            : { codigo },
          eventHash: await hashEvento(item.id, codigo),
        },
      });
      falhas += 1;
    }
  }
  return {
    processados: items.length,
    enviados,
    falhas,
    codigosErro,
    modo: gateway instanceof DryRunMailGateway ? "DRY_RUN" : "LIVE_PILOT",
  };
}

/**
 * Seção 6 — escape de conteúdo HTML. Padrão idêntico aos templates
 * homologados (@integra-correios/mail/templates/pf-pilot.ts) — componente
 * reutilizado por convenção, sem duplicar export público.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

/**
 * Erro sanitizado: código curto determinístico, sem payload nem PII.
 * Seção 7 — classes específicas do transporte Gmail têm precedência sobre a
 * classificação por mensagem: a categoria orienta o retry do chamador.
 * (Exportada para testes unitários — função pura, sem secret.)
 */
export function sanitizarErro(error: unknown): string {
  if (error instanceof GmailAuthError) return "AUTH_REQUIRED";
  if (error instanceof GmailPermanentPolicyError) {
    const mensagem = error.message;
    // OUTBOX_GATE_CHAIN_FIX — bloqueios de gate pré-messages.send com OAuth
    // persistido ativo têm código PRÓPRIO (não colapsam em FAILED_PERMANENT):
    // distinguem "gate recusou antes da rede" de falha real do provider.
    if (mensagem.includes("OAUTH_NOT_READY")) return "CONTROLLED_GATE_OAUTH_NOT_READY";
    if (mensagem.includes("ACCESS_TOKEN_UNAVAILABLE")) return "OAUTH_NOT_CONNECTED";
    return "FAILED_PERMANENT";
  }
  if (error instanceof GmailRateLimitError) return "RATE_LIMITED";
  if (error instanceof GmailAmbiguousError) return "DELIVERY_UNKNOWN";
  const mensagem = error instanceof Error ? error.message : String(error);
  if (/REAL_SEND_ENABLED/.test(mensagem)) return "SEND_DISABLED";
  if (/não configurado/.test(mensagem)) return "PROVIDER_NOT_CONFIGURED";
  if (/não conectada/.test(mensagem)) return "OAUTH_NOT_CONNECTED";
  return "PROVIDER_ERROR";
}

/**
 * Seção 7 — política de retry por código:
 *  - DELIVERY_UNKNOWN / AUTH_REQUIRED: SEM retry automático (resultado
 *    ambíguo nunca reenviado durante o piloto; auth exige reconexão humana);
 *  - RATE_LIMITED: backoff exponencial truncado com jitter;
 *  - demais falhas: retry curto fixo até MAX_TENTATIVAS.
 */
export function calcularRetryAt(codigo: string, tentativas: number, now: Date): Date {
  if (codigo === "DELIVERY_UNKNOWN" || codigo === "AUTH_REQUIRED") {
    return new Date(now.getTime() + 30 * 24 * 3_600_000);
  }
  // OUTBOX_GATE_CHAIN_FIX — códigos TERMINAIS nunca voltam à fila
  // automaticamente: o agendamento genérico não pode reprocessar uma falha
  // que exige recuperação auditada exclusiva (mesma janela de 30 dias).
  if (codigo === "FAILED_PERMANENT" || codigo === "CONTROLLED_GATE_OAUTH_NOT_READY") {
    return new Date(now.getTime() + 30 * 24 * 3_600_000);
  }
  if (tentativas >= MAX_TENTATIVAS) {
    return new Date(now.getTime() + 30 * 24 * 3_600_000);
  }
  if (codigo === "RATE_LIMITED") {
    const backoffMs = Math.min(2 ** tentativas * 60_000, 30 * 60_000);
    const jitterMs = Math.floor(Math.random() * 30_000);
    return new Date(now.getTime() + backoffMs + jitterMs);
  }
  return new Date(now.getTime() + 5 * 60_000);
}

async function hashEvento(id: string, sal: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(id).update(sal).digest("hex");
}

/**
 * F3 — Provedor de access token ligado ao repositório OAuth:
 * oauth_connection → decrypt → expiry check → refresh quando necessário
 * → persistir token renovado → token em memória. Nenhum secret em log.
 */
export function criarAccessTokenProvider(
  env: Readonly<Record<string, string | undefined>>,
  credentials: GmailOauthCredentialSource,
  caixa: Aes256GcmSecretBox,
  repository: PostgresOperationalRepository,
): () => Promise<string | undefined> {
  const config = loadGmailOauthConfig(env);
  const fingerprinter = new HmacSha256Fingerprinter(
    Buffer.from(env.DOCUMENT_FINGERPRINT_KEY_BASE64 ?? "", "base64"),
  );
  const transporte = new GmailHttpTransport();
  // F14: lookup deriva o fingerprint da CONTA ESPERADA (GMAIL_EXPECTED_ACCOUNT)
  // pela MESMA função usada no callback OAuth (que persiste com a identidade
  // verificada == conta esperada). Ambos os lados convergem no mesmo valor.
  const esperada = env.GMAIL_EXPECTED_ACCOUNT?.trim().toLowerCase() ?? "";
  const accountFingerprint = esperada
    ? derivarFingerprintContaGmail(fingerprinter, esperada)
    : "";
  let cache: { token: string; expiraEmMs: number } | undefined;
  return async () => {
    if (!config || !accountFingerprint) return undefined;
    if (cache && cache.expiraEmMs > Date.now() + 60_000) return cache.token;
    const conexao = await credentials.loadGmailConnection(accountFingerprint);
    if (!conexao) return undefined;
    const expiraEm = conexao.expiresAt ? Date.parse(conexao.expiresAt) : 0;
    if (expiraEm > Date.now() + 60_000) {
      const token = new TextDecoder().decode(caixa.open(conexao.accessToken, "oauth:access"));
      cache = { token, expiraEmMs: expiraEm };
      return token;
    }
    if (!conexao.refreshToken) return undefined;
    const refresh = new TextDecoder().decode(caixa.open(conexao.refreshToken, "oauth:refresh"));
    const renovado = await transporte.refreshAccessToken(config, refresh);
    const novoExpiraEm = new Date(Date.now() + renovado.expires_in * 1000).toISOString();
    await repository.refreshOauthAccessToken({
      connectionId: conexao.id,
      accountFingerprint,
      accessToken: caixa.seal(renovado.access_token, "oauth:access"),
      expiresAt: novoExpiraEm,
    });
    cache = { token: renovado.access_token, expiraEmMs: Date.parse(novoExpiraEm) };
    return renovado.access_token;
  };
}

/** Gateway escolhido pelo AMBIENTE + modo explícito (nunca pelo browser). */
export function criarGatewayDoAmbiente(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dryRun: boolean = false,
  opcoes: {
    credentials?: GmailOauthCredentialSource;
    repository?: PostgresOperationalRepository;
    caixa?: Aes256GcmSecretBox;
    /** GATE 2 (modo controlado): verificação por comunicação antes do send. */
    gateControlado?: (
      communicationId: string,
      destinatario: string,
    ) => Promise<{ ok: true } | { ok: false; motivo: string }>;
  } = {},
): MailGateway {
  const realSendEnabled = env.REAL_SEND_ENABLED === "true";
  if (dryRun || !realSendEnabled) {
    return new DryRunMailGateway();
  }
  const provider = env.MAIL_PROVIDER?.trim().toUpperCase();
  if (provider === "GMAIL") {
    const transporte = new GmailHttpTransport();
    const { credentials, repository, caixa } = opcoes;
    if (!credentials || !repository || !caixa) {
      // Sem repositório OAuth injetado o envio real é fail-closed: nunca há
      // caminho LIVE com token ausente por construção.
      return new DisabledMailGateway("GMAIL");
    }
    const loadAccessToken = criarAccessTokenProvider(env, credentials, caixa, repository);
    // GATE 2: quando o modo controlado está ativo, cada envio passa pela
    // verificação (fonte sintética, destinatário controlado, lote ATIVO de
    // 1 item, liberação auditada, sem receipt) ANTES da chamada ao Gmail.
    //
    // OUTBOX_GATE_CHAIN_FIX — o gate roda ANTES de carregar/renovar o access
    // token: uma recusa do gate NUNCA gera refresh em oauth2.googleapis.com/token
    // nem consome chamada de rede. A ordem anterior (token → gate) consumia o
    // refresh mesmo com zero chamadas messages.send.
    const gate = opcoes.gateControlado;
    const transporteComGate: (message: OutboundMail, accessToken: string) => Promise<MailReceipt> = gate
      ? async (message, _accessToken) => {
          const communicationId = message.communicationId ?? "";
          const veredito = await gate(communicationId, message.to);
          if (!veredito.ok) {
            // Zero chamadas ao Gmail: a divergência é recusada ANTES do
            // transporte e ANTES do token. Erro classificado como permanente
            // (sem retry); o motivo específico preserva o diagnóstico.
            throw new GmailPermanentPolicyError(`controlled-gate: ${veredito.motivo}`);
          }
          const accessToken = await loadAccessToken();
          if (!accessToken) {
            // Fail-closed sem rede: sem token não há chamada messages.send.
            throw new GmailPermanentPolicyError("controlled-gate: ACCESS_TOKEN_UNAVAILABLE");
          }
          return transporte.send(message, accessToken);
        }
      : (message, accessToken) => transporte.send(message, accessToken);
    return new GmailMailGateway(
      transporteComGate,
      gate
        ? // OUTBOX_GATE_CHAIN_FIX — com gate presente, o token NÃO é resolvido
          // pelo gateway (a ordem token→gate causava refresh sem envio). O
          // gateway recebe um sentinel não-vazio (apenas para atravessar a
          // checagem interna de "conta conectada") e o transporteComGate
          // resolve o token REAL somente DEPOIS do gate aprovado.
          async () => "gate-delega-token"
        : loadAccessToken,
      () => new Date(),
      // GATE 1 honra o AMBIENTE INJETADO (não o process.env do processo).
      env,
    );
  }
  return new DisabledMailGateway("GMAIL");
}

/** Sonda de conectividade real (SELECT 1) — sem ecoar DSN. */
export async function sondarDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  if (!env.DATABASE_URL?.trim()) return false;
  const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.close();
  }
}

export async function avaliarReadinessDoProcesso(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ReadinessReport> {
  return avaliarReadiness(env, () => sondarDatabase(env), async () => {
    // F2: leitura da oauth_connection persistida (sem secrets no relatório).
    if (!env.DATABASE_URL?.trim() || !env.DATA_ENCRYPTION_KEY_BASE64?.trim()) return false;
    const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      const repository = new PostgresOperationalRepository(pool);
      return await repository.existeConexaoGmailAtiva();
    } catch {
      return false;
    } finally {
      await pool.close();
    }
  }, async () => {
    // Seção 5 — REAL_SEND_EXECUTED: evidência vem do ledger de auditoria
    // existente (aceitação persistida em lote LIVE_PILOT). Sem DSN, falso.
    if (!env.DATABASE_URL?.trim()) return false;
    const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      const resultado = await pool.query(
        `SELECT 1
         FROM evento_auditoria ea
         JOIN comunicacao c ON c.id = ea.agregado_id
           AND ea.agregado_tipo = 'COMUNICACAO'
         JOIN lote_comunicacao lc ON lc.id = c.lote_comunicacao_id
         WHERE ea.tipo = 'PF_COMMUNICATION_ACCEPTED'
           AND lc.modo = 'LIVE_PILOT'
         LIMIT 1`,
      );
      return (resultado.rowCount ?? 0) > 0;
    } catch {
      return false;
    } finally {
      await pool.close();
    }
  });
}

/**
 * Execução controlada de UMA iteração do worker (run-once), server-side.
 *  1. readiness: recusa se requisitos internos não estiverem READY;
 *  2. SEMPRE DRY_RUN (F6): esta função é a entrada do Preview/operador e
 *     NUNCA aceita modo do browser — envio real só via executarWorkerUmaVezLive,
 *     separado e explicitamente autorizado;
 *  3. métricas sanitizadas (sem payload, sem destinatário).
 */
export async function executarWorkerUmaVez(
  opcoes: { workerId?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ readiness: ReadinessReport; resultado?: WorkerResult; motivo?: string }> {
  const resultado = await executarWorkerDoModo({ dryRun: true, ...opcoes });
  return {
    readiness: resultado.readiness,
    ...(resultado.resultado !== undefined ? { resultado: resultado.resultado } : {}),
    ...(resultado.motivo !== undefined ? { motivo: resultado.motivo } : {}),
  };
}

/**
 * F6 — Motor LIVE separado: NÃO é acessível pela rota do Preview. Exige
 * chamador explicitamente autorizado (CLI com REAL_SEND_ENABLED=true + lote
 * ATIVO). O browser jamais alcança este caminho.
 *
 * CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — propagar {readiness, motivo}:
 * o chamador NUNCA pode interpretar "nada enviado" como execução concluída.
 */
export async function executarWorkerUmaVezLive(
  opcoes: { workerId?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ readiness: ReadinessReport; resultado?: WorkerResult; motivo?: string }> {
  return executarWorkerDoModo({ dryRun: false, ...opcoes });
}

async function executarWorkerDoModo(
  opcoes: { dryRun: boolean; workerId?: string; env?: Readonly<Record<string, string | undefined>> },
): Promise<{ readiness: ReadinessReport; resultado?: WorkerResult; motivo?: string }> {
  const env = opcoes.env ?? process.env;
  // OUTBOX_GATE_CHAIN_FIX — readiness LIVE injeta a leitura da oauth_connection
  // PERSISTIDA: sem isso gmailOauth ficava "não conectado" mesmo com a conta
  // conectada (painel/banco), e o gate recebia oauthPronto=false incorretamente.
  // No LIVE o worker abre o pool de qualquer forma; a leitura usa o MESMO pool.
  const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL, max: 4 });
  try {
    const repository = new PostgresOperationalRepository(pool);
    const readiness = await avaliarReadiness(env, () => sondarDatabase(env), () =>
      repository.existeConexaoGmailAtiva(),
    );
    return await executarWorkerDoModoInterno(opcoes, env, pool, repository, readiness);
  } finally {
    await pool.close();
  }
}

async function executarWorkerDoModoInterno(
  opcoes: { dryRun: boolean; workerId?: string; env?: Readonly<Record<string, string | undefined>> },
  env: Readonly<Record<string, string | undefined>>,
  pool: NodePostgresPool,
  repository: PostgresOperationalRepository,
  readiness: ReadinessReport,
): Promise<{ readiness: ReadinessReport; resultado?: WorkerResult; motivo?: string }> {
  const veredito = workerPodeExecutar(readiness, env, { live: !opcoes.dryRun });
  if (!veredito.ok) {
    return { readiness, motivo: veredito.motivo };
  }
  const live = !opcoes.dryRun;
  if (live && readiness.realSend.status !== "BLOCKED_EXTERNAL" && readiness.realSend.status !== "READY") {
    return { readiness, motivo: "REAL_SEND_DISABLED" };
  }
  // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — defesa em profundidade: mesmo que
  // outro caminho chegue aqui em LIVE, sem MAIL_PROVIDER=Gmail o gateway real
  // seria o desabilitado. Recusa ANTES do pool/claim, sem consumir tentativa.
  if (live && !providerGmailConfigurado(env)) {
    return { readiness, motivo: "PROVIDER_NOT_CONFIGURED" };
  }
  const caixa = new Aes256GcmSecretBox(
    Buffer.from(env.DATA_ENCRYPTION_KEY_BASE64 ?? "", "base64"),
    env.DATA_ENCRYPTION_KEY_VERSION ?? "v1",
  );
  // FINAL CLOSURE GATE item 2 — modo controlado: GATE 2 REAL por
  // comunicação, imediatamente antes de users.messages.send (somente no
  // caminho LIVE; o DRY_RUN nunca chama o Gmail de qualquer forma).
  const controlledMode = env.GMAIL_CONTROLLED_MODE === "true";
  const controlledRecipient = (env.GMAIL_CONTROLLED_RECIPIENT ?? "").trim();
  const gateway = criarGatewayDoAmbiente(env, !live, {
    credentials: repository,
    repository,
    caixa,
    ...(live && controlledMode && controlledRecipient
      ? {
          gateControlado: (communicationId: string, destinatario: string) =>
            repository.verificarEnvioControlado({
              fonte: "CONTROLADO_SINTETICO",
              communicationId,
              destinatario,
              oauthPronto: readiness.gmailOauth.status === "READY",
            }),
        }
      : {}),
  });
  const resultado = await processarOutboxUmaVez(
    opcoes.workerId ?? `worker-${process.pid}`,
    pool,
    gateway,
    caixa,
    repository,
    new Date(),
    live ? "LIVE_PILOT" : "DRY_RUN",
  );
  // F7: o modo declarado pelo gateway é conferido contra o modo dos lotes
  // reclamados — divergência é impossível por construção (claim filtra por
  // status do lote, e o gateway é escolhido server-side), mas a checagem
  // torna a invariante explícita.
  if (resultado && resultado.modo !== (live ? "LIVE_PILOT" : "DRY_RUN")) {
    return { readiness, motivo: "MODE_MISMATCH" };
  }
  return { readiness, resultado };
}

/** Entrada CLI: uma iteração por invocação (sem daemon — piloto one-time). */
export async function main(): Promise<void> {
  const { readiness, resultado, motivo } = await executarWorkerUmaVez();
  if (!resultado) {
    process.stdout.write(
      `${JSON.stringify({ executado: false, motivo, modo: readiness.executionMode })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ executado: true, ...resultado })}\n`);
}
