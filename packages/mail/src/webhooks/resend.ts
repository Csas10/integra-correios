import {
  loadHomologationMailPolicy,
  readHomologationSecret,
} from "../config/homologation.js";
import { ResendSdkTransport, type ResendTransport } from "../adapters/resend.js";
import type { MailDelivery, MailDeliveryStatus } from "../domain/message.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ResendWebhookHeaders {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

export interface SanitizedMailDeliveryEvent extends MailDelivery {
  readonly eventId: string;
}

export interface WebhookEventOwnership {
  registerOnce(eventId: string): Promise<boolean>;
}

export class InMemoryWebhookEventOwnership implements WebhookEventOwnership {
  readonly #eventIds = new Set<string>();

  async registerOnce(eventId: string): Promise<boolean> {
    if (this.#eventIds.has(eventId)) return false;
    this.#eventIds.add(eventId);
    return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusForEvent(type: string): MailDeliveryStatus | undefined {
  switch (type) {
    case "email.sent":
      return "ACCEPTED";
    case "email.scheduled":
    case "email.delivery_delayed":
      return "QUEUED";
    case "email.delivered":
      return "DELIVERED";
    case "email.bounced":
      return "BOUNCED";
    case "email.failed":
    case "email.suppressed":
    case "email.complained":
      return "FAILED";
    default:
      return undefined;
  }
}

function toSanitizedEvent(
  payload: unknown,
  eventId: string,
): SanitizedMailDeliveryEvent | undefined {
  if (!isObject(payload) || typeof payload.type !== "string") return undefined;
  const status = statusForEvent(payload.type);
  if (!status || typeof payload.created_at !== "string" || !isObject(payload.data)) {
    return undefined;
  }
  const messageId = payload.data.email_id;
  if (typeof messageId !== "string" || !messageId) return undefined;
  return {
    eventId,
    provider: "RESEND",
    messageId,
    status,
    observedAt: payload.created_at,
  };
}

export class ResendWebhookProcessor {
  readonly #transport: ResendTransport;
  readonly #webhookSecret: string;
  readonly #ownership: WebhookEventOwnership;

  constructor(
    transport: ResendTransport,
    webhookSecret: string,
    ownership: WebhookEventOwnership = new InMemoryWebhookEventOwnership(),
  ) {
    this.#transport = transport;
    this.#webhookSecret = webhookSecret;
    this.#ownership = ownership;
  }

  async process(
    rawBody: string,
    headers: ResendWebhookHeaders,
  ): Promise<SanitizedMailDeliveryEvent | undefined> {
    const payload = this.#transport.verifyWebhook({
      payload: rawBody,
      headers,
      webhookSecret: this.#webhookSecret,
    });
    const event = toSanitizedEvent(payload, headers.id);
    if (!event) return undefined;
    if (!(await this.#ownership.registerOnce(headers.id))) return undefined;
    return event;
  }
}

export function readResendWebhookHeaders(headers: Headers): ResendWebhookHeaders {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    throw new Error("Cabeçalhos de assinatura do webhook ausentes");
  }
  return { id, timestamp, signature };
}

export function createResendWebhookProcessorFromEnv(
  env: Environment = process.env,
): ResendWebhookProcessor {
  loadHomologationMailPolicy(env);
  const transport = new ResendSdkTransport(readHomologationSecret(env, "RESEND_API_KEY"));
  return new ResendWebhookProcessor(
    transport,
    readHomologationSecret(env, "RESEND_WEBHOOK_SECRET"),
  );
}
