import {
  DisabledMailGateway,
  GmailHttpTransport,
  GmailMailGateway,
  type MailGateway,
  type OutboundMail,
} from "@integra-correios/mail";
import {
  NodePostgresPool,
  PostgresOperationalRepository,
  Aes256GcmSecretBox,
  type ClaimedOutboxItem,
} from "@integra-correios/persistence";
import { avaliarReadiness, workerPodeExecutar, type ReadinessReport } from "./readiness.js";

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

/** Gateway sintético do DRY_RUN: nunca sai da máquina, receipt determinístico. */
export class DryRunMailGateway implements MailGateway {
  readonly enviadas: readonly OutboundMail[] = [];

  async send(message: OutboundMail) {
    (this.enviadas as OutboundMail[]).push(message);
    return {
      provider: "GMAIL" as const,
      messageId: `dryrun-${message.confirmationId}`,
      acceptedAt: new Date().toISOString(),
    };
  }

  async getStatus(messageId: string) {
    return {
      provider: "GMAIL" as const,
      messageId,
      status: "ACCEPTED" as const,
      observedAt: new Date().toISOString(),
    };
  }
}

function mailFromPayload(payload: any): OutboundMail {
  const base = new URL(payload.confirmationBaseUrl);
  const confirmUrl = new URL(`/confirma/${encodeURIComponent(payload.plainToken)}`, base).toString();
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
    htmlBody: `<p>Olá, <strong>${payload.nome}</strong>.</p><p>Confirme ou atualize seus dados cadastrais.</p><p><a href="${confirmUrl}">CONFIRMAR DADOS / ATUALIZAR DADOS</a></p>`,
    templateVersion: "pf-pilot-crtba-v1",
  };
}

export async function processarOutboxUmaVez(
  workerId: string,
  pool: NodePostgresPool,
  gateway: MailGateway,
  caixa: Aes256GcmSecretBox,
  repository: PostgresOperationalRepository,
  now: Date = new Date(),
): Promise<WorkerResult> {
  const items = await repository.claimOutbox(workerId, 10, now.toISOString());
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
      await repository.markOutboxFailed({
        outboxId: item.id,
        communicationId: item.communicationId,
        errorCode: codigo,
        retryAt:
          item.attempts >= MAX_TENTATIVAS
            ? new Date(now.getTime() + 30 * 24 * 3_600_000).toISOString()
            : new Date(now.getTime() + 5 * 60_000).toISOString(),
        auditEvent: {
          id: crypto.randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: item.communicationId,
          type: "PF_COMMUNICATION_FAILED",
          occurredAt: now.toISOString(),
          metadata:
            item.attempts >= MAX_TENTATIVAS
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

/** Erro sanitizado: código curto determinístico, sem payload nem PII. */
function sanitizarErro(error: unknown): string {
  const mensagem = error instanceof Error ? error.message : String(error);
  if (/REAL_SEND_ENABLED/.test(mensagem)) return "SEND_DISABLED";
  if (/não configurado/.test(mensagem)) return "PROVIDER_NOT_CONFIGURED";
  if (/não conectada/.test(mensagem)) return "OAUTH_NOT_CONNECTED";
  return "PROVIDER_ERROR";
}

async function hashEvento(id: string, sal: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(id).update(sal).digest("hex");
}

/** Gateway escolhido pelo AMBIENTE + modo explícito (nunca pelo browser). */
export function criarGatewayDoAmbiente(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dryRun: boolean = false,
): MailGateway {
  const realSendEnabled = env.REAL_SEND_ENABLED === "true";
  if (dryRun || !realSendEnabled) {
    return new DryRunMailGateway();
  }
  const provider = env.MAIL_PROVIDER?.trim().toUpperCase();
  if (provider === "GMAIL") {
    const transporte = new GmailHttpTransport();
    return new GmailMailGateway(
      (message, accessToken) => transporte.send(message, accessToken),
      async () => undefined, // conexão real é injetada pelo OAuth do titular (Fase C do titular)
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
  return avaliarReadiness(env, () => sondarDatabase(env));
}

/**
 * Execução controlada de UMA iteração do worker (run-once), server-side.
 *  1. readiness: recusa se requisitos internos não estiverem READY;
 *  2. DRY_RUN: gateway sintético (default) — LIVE_PILOT exige flag explícita
 *     do chamador autorizado + REAL_SEND_ENABLED=true;
 *  3. métricas sanitizadas (sem payload, sem destinatário).
 */
export async function executarWorkerUmaVez(
  opcoes: { dryRun?: boolean; workerId?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ readiness: ReadinessReport; resultado?: WorkerResult; motivo?: string }> {
  const env = opcoes.env ?? process.env;
  const readiness = await avaliarReadiness(env, () => sondarDatabase(env));
  const veredito = workerPodeExecutar(readiness);
  if (!veredito.ok) {
    return { readiness, motivo: veredito.motivo };
  }
  const live = opcoes.dryRun !== true;
  if (live && readiness.realSend.status !== "BLOCKED_EXTERNAL" && readiness.realSend.status !== "READY") {
    return { readiness, motivo: "REAL_SEND_DISABLED" };
  }
  const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL, max: 4 });
  try {
    const caixa = new Aes256GcmSecretBox(
      Buffer.from(env.DATA_ENCRYPTION_KEY_BASE64 ?? "", "base64"),
      env.DATA_ENCRYPTION_KEY_VERSION ?? "v1",
    );
    const repository = new PostgresOperationalRepository(pool);
    const gateway = criarGatewayDoAmbiente(env, !live);
    const resultado = await processarOutboxUmaVez(
      opcoes.workerId ?? `worker-${process.pid}`,
      pool,
      gateway,
      caixa,
      repository,
    );
    return { readiness, resultado };
  } finally {
    await pool.close();
  }
}

/** Entrada CLI: uma iteração por invocação (sem daemon — piloto one-time). */
export async function main(): Promise<void> {
  const { readiness, resultado, motivo } = await executarWorkerUmaVez({ dryRun: false });
  if (!resultado) {
    process.stdout.write(
      `${JSON.stringify({ executado: false, motivo, modo: readiness.executionMode })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ executado: true, ...resultado })}\n`);
}
