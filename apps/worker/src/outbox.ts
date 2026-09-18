import {
  DisabledMailGateway,
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

/**
 * Worker da outbox — reusa o modelo validado na V0:
 *  - claim com FOR UPDATE SKIP LOCKED + lease (bloqueada_em);
 *  - retry controlado (tentativas + disponivel_em);
 *  - idempotência (markOutboxAccepted aceita repetição com mesmo receipt);
 *  - erro SANITIZADO (código curto, sem payload/PII);
 *  - nunca marca SENT sem receipt válido.
 *
 * HARD GATE: REAL_SEND_ENABLED=false mantém o gateway GMAIL fail-closed —
 * o worker NUNCA chama o Gmail real. Com REAL_SEND_ENABLED=false e sem
 * provider configurado, os itens são marcados FAILED com código
 * SEND_DISABLED (estado visível ao operador, sem envio externo).
 */

export const MAX_TENTATIVAS = 3;

export interface WorkerResult {
  readonly processados: number;
  readonly enviados: number;
  readonly falhas: number;
  readonly codigosErro: readonly string[];
}

function mailFromPayload(payload: any): OutboundMail {
  const base = new URL(payload.confirmationBaseUrl);
  const confirmUrl = new URL(`/confirma/${encodeURIComponent(payload.plainToken)}`, base).toString();
  // Mesma URL base com decision=ATUALIZAR preservada no token; o form do
  // profissional escolhe CONFIRMAR/ATUALIZAR — uma única URL one-time.
  const message: OutboundMail = {
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
  return message;
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
    try {
      const plaintext = caixa.open(item.encryptedPayload, "outbox:email");
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      const message = mailFromPayload(payload);
      const receipt = await gateway.send(message);
      await repository.markOutboxAccepted({
        outboxId: item.id,
        communicationId: item.communicationId,
        provider: receipt.provider === "MICROSOFT_GRAPH" ? "RESEND" : receipt.provider,
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
      if (item.attempts >= MAX_TENTATIVAS) {
        // Retry esgotado: FAILED final (disponivel_em no futuro distante).
        await repository.markOutboxFailed({
          outboxId: item.id,
          communicationId: item.communicationId,
          errorCode: codigo,
          retryAt: new Date(now.getTime() + 30 * 24 * 3_600_000).toISOString(),
          auditEvent: {
            id: crypto.randomUUID(),
            aggregateType: "COMUNICACAO",
            aggregateId: item.communicationId,
            type: "PF_COMMUNICATION_FAILED",
            occurredAt: now.toISOString(),
            metadata: { codigo, final: true },
            eventHash: await hashEvento(item.id, codigo),
          },
        });
      } else {
        await repository.markOutboxFailed({
          outboxId: item.id,
          communicationId: item.communicationId,
          errorCode: codigo,
          retryAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
          auditEvent: {
            id: crypto.randomUUID(),
            aggregateType: "COMUNICACAO",
            aggregateId: item.communicationId,
            type: "PF_COMMUNICATION_FAILED",
            occurredAt: now.toISOString(),
            metadata: { codigo },
            eventHash: await hashEvento(item.id, codigo),
          },
        });
      }
      falhas += 1;
    }
  }
  return { processados: items.length, enviados, falhas, codigosErro };
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

/**
 * Gateway escolhido pelo AMBIENTE (nunca pelo browser):
 *  - REAL_SEND_ENABLED=false → DisabledMailGateway (fail-closed padrão);
 *  - MAIL_PROVIDER=gmail + REAL_SEND_ENABLED=true → GmailMailGateway real
 *    (somente após OAuth do titular + autorização humana — Fase C).
 */
export function criarGatewayDoAmbiente(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loadAccessToken?: () => Promise<string | undefined>,
): MailGateway {
  const realSendEnabled = env.REAL_SEND_ENABLED === "true";
  if (!realSendEnabled) {
    return new DisabledMailGateway("GMAIL");
  }
  const provider = env.MAIL_PROVIDER?.trim().toUpperCase();
  if (provider === "GMAIL") {
    return new GmailMailGateway(
      async (message, accessToken) => {
        // Transport Gmail real será ativado apenas na Fase C com autorização
        // humana. Nesta fase o fail-closed do REAL_SEND_ENABLED impede chegar
        // aqui quando false; com true, o transport exige implementação real.
        throw new Error(
          `GMAIL transport não implementado nesta fase (REAL_SEND_ENABLED=${env.REAL_SEND_ENABLED}, mensagem ${message.confirmationId})`,
        );
      },
      loadAccessToken ?? (async () => undefined),
    );
  }
  return new DisabledMailGateway("GMAIL");
}

// Entrada CLI: um ciclo de processamento por invocação (sem loop daemon
// nesta fase — o piloto é one-time e supervisionado).
export async function main(): Promise<void> {
  const env = process.env;
  const pool = new NodePostgresPool({ connectionString: env.DATABASE_URL });
  try {
    const caixa = new Aes256GcmSecretBox(
      Buffer.from(env.DATA_ENCRYPTION_KEY_BASE64 ?? "", "base64"),
      env.DATA_ENCRYPTION_KEY_VERSION ?? "v1",
    );
    const repository = new PostgresOperationalRepository(pool);
    const gateway = criarGatewayDoAmbiente(env);
    const resultado = await processarOutboxUmaVez(
      env.WORKER_ID ?? `worker-${process.pid}`,
      pool,
      gateway,
      caixa,
      repository,
    );
    process.stdout.write(`${JSON.stringify(resultado)}\n`);
  } finally {
    await pool.close();
  }
}

if (process.argv[1]?.includes("worker")) {
  await main();
}
