export const MAIL_PROVIDERS = ["GMAIL", "MICROSOFT_GRAPH", "RESEND", "DRY_RUN"] as const;

export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export const MAIL_DELIVERY_STATUSES = [
  "QUEUED",
  "ACCEPTED",
  "DELIVERED",
  "BOUNCED",
  "FAILED",
] as const;

export type MailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

export interface OutboundMail {
  readonly idempotencyKey: string;
  readonly confirmationId: string;
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly templateVersion: string;
}

export interface MailReceipt {
  readonly provider: MailProvider;
  readonly messageId: string;
  /** threadId do provedor quando disponível (Gmail messages.send). */
  readonly threadId?: string;
  readonly acceptedAt: string;
}

export interface MailDelivery {
  readonly provider: MailProvider;
  readonly messageId: string;
  readonly status: MailDeliveryStatus;
  readonly observedAt: string;
}
