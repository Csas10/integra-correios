import { Resend } from "resend";
import {
  loadHomologationMailPolicy,
  MailHomologationConfigError,
  readHomologationSecret,
  type HomologationMailPolicy,
} from "../config/homologation.js";
import {
  DestinatarioNaoAutorizadoError,
  MailProviderRequestError,
  type MailGateway,
} from "../domain/gateway.js";
import type {
  MailDelivery,
  MailDeliveryStatus,
  MailReceipt,
  OutboundMail,
} from "../domain/message.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ResendSendInput {
  readonly from: string;
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly tags: readonly { readonly name: string; readonly value: string }[];
}

export interface ResendRetrievedEmail {
  readonly id: string;
  readonly lastEvent: string;
}

export interface ResendWebhookVerificationInput {
  readonly payload: string;
  readonly headers: {
    readonly id: string;
    readonly timestamp: string;
    readonly signature: string;
  };
  readonly webhookSecret: string;
}

export interface ResendTransport {
  send(input: ResendSendInput, idempotencyKey: string): Promise<string>;
  retrieve(messageId: string): Promise<ResendRetrievedEmail>;
  verifyWebhook(input: ResendWebhookVerificationInput): unknown;
}

export class ResendSdkTransport implements ResendTransport {
  readonly #client: Resend;

  constructor(apiKey: string) {
    this.#client = new Resend(apiKey);
  }

  async send(input: ResendSendInput, idempotencyKey: string): Promise<string> {
    const response = await this.#client.emails.send(
      {
        from: input.from,
        to: input.to,
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.text,
        html: input.html,
        tags: [...input.tags],
      },
      { idempotencyKey },
    );
    if (response.error) throw new MailProviderRequestError("RESEND", "envio");
    return response.data.id;
  }

  async retrieve(messageId: string): Promise<ResendRetrievedEmail> {
    const response = await this.#client.emails.get(messageId);
    if (response.error) throw new MailProviderRequestError("RESEND", "consulta de status");
    return { id: response.data.id, lastEvent: response.data.last_event };
  }

  verifyWebhook(input: ResendWebhookVerificationInput): unknown {
    return this.#client.webhooks.verify(input);
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

function mapDeliveryStatus(lastEvent: string): MailDeliveryStatus {
  switch (lastEvent) {
    case "delivered":
      return "DELIVERED";
    case "bounced":
      return "BOUNCED";
    case "failed":
    case "suppressed":
    case "complained":
    case "canceled":
      return "FAILED";
    case "sent":
      return "ACCEPTED";
    default:
      return "QUEUED";
  }
}

export class ResendMailGateway implements MailGateway {
  readonly #allowedRecipients: ReadonlySet<string>;

  constructor(
    readonly policy: HomologationMailPolicy,
    readonly transport: ResendTransport,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.#allowedRecipients = new Set(policy.allowedRecipients);
  }

  async send(message: OutboundMail): Promise<MailReceipt> {
    const recipient = normalizedEmail(message.to);
    if (!this.#allowedRecipients.has(recipient)) {
      throw new DestinatarioNaoAutorizadoError();
    }
    if (normalizedEmail(message.replyTo) !== this.policy.replyTo) {
      throw new MailHomologationConfigError("Reply-To da mensagem diverge da política de homologação");
    }
    if (!message.idempotencyKey || message.idempotencyKey.length > 256) {
      throw new MailHomologationConfigError("Chave de idempotência inválida");
    }

    const messageId = await this.transport.send(
      {
        from: `${this.policy.fromName} <${this.policy.fromAddress}>`,
        to: recipient,
        replyTo: this.policy.replyTo,
        subject: message.subject,
        text: message.textBody,
        html: message.htmlBody,
        tags: [
          { name: "confirmation_id", value: tagValue(message.confirmationId) },
          { name: "template_version", value: tagValue(message.templateVersion) },
        ],
      },
      message.idempotencyKey,
    );

    return {
      provider: "RESEND",
      messageId,
      acceptedAt: this.clock().toISOString(),
    };
  }

  async getStatus(messageId: string): Promise<MailDelivery> {
    const email = await this.transport.retrieve(messageId);
    return {
      provider: "RESEND",
      messageId: email.id,
      status: mapDeliveryStatus(email.lastEvent),
      observedAt: this.clock().toISOString(),
    };
  }
}

export function createResendHomologationGatewayFromEnv(
  env: Environment = process.env,
): ResendMailGateway {
  const policy = loadHomologationMailPolicy(env);
  const transport = new ResendSdkTransport(readHomologationSecret(env, "RESEND_API_KEY"));
  return new ResendMailGateway(policy, transport);
}
