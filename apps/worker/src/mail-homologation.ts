import {
  createResendHomologationGatewayFromEnv,
  loadConfirmationBaseUrl,
  loadHomologationMailPolicy,
  renderPfConfirmationMail,
} from "@integra-correios/mail";
import { createWebTokenService } from "@integra-correios/pf-workflow";

const CONFIRMATION_FLAG = "--confirm-send=HOMOLOGATION";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export async function runMailHomologation(): Promise<void> {
  if (!process.argv.includes(CONFIRMATION_FLAG)) {
    throw new Error(`Envio bloqueado: informe ${CONFIRMATION_FLAG}`);
  }

  const recipient = argument("recipient")?.trim().toLowerCase();
  if (!recipient) throw new Error("Envio bloqueado: informe --recipient=<e-mail autorizado>");

  const policy = loadHomologationMailPolicy(process.env);
  const confirmationBaseUrl = loadConfirmationBaseUrl(process.env);
  const token = await createWebTokenService().issue();
  const confirmationId = crypto.randomUUID();
  const confirmationUrl = new URL(
    `/confirma/${encodeURIComponent(token.plainToken)}`,
    confirmationBaseUrl,
  ).toString();
  const message = renderPfConfirmationMail({
    confirmationId,
    professionalId: "PF|HOMOLOGACAO-MAIL",
    recipient,
    professionalName: "Pessoa de Teste",
    replyTo: policy.replyTo,
    confirmationUrl,
  });

  const gateway = createResendHomologationGatewayFromEnv(process.env);
  const receipt = await gateway.send(message);
  let idempotencyVerified = false;
  if (process.argv.includes("--verify-idempotency")) {
    const repeatedReceipt = await gateway.send(message);
    if (repeatedReceipt.messageId !== receipt.messageId) {
      throw new Error("Provedor retornou IDs diferentes para a mesma chave de idempotência");
    }
    idempotencyVerified = true;
  }
  process.stdout.write(`${JSON.stringify({
    provider: receipt.provider,
    messageId: receipt.messageId,
    acceptedAt: receipt.acceptedAt,
    confirmationId,
    templateVersion: message.templateVersion,
    idempotencyVerified,
  })}\n`);
}

await runMailHomologation();
