import { emailValido } from "@integra-correios/validation";

export const MAIL_HOMOLOGATION_MAX_RECIPIENTS = 5;

type Environment = Readonly<Record<string, string | undefined>>;

export interface HomologationMailPolicy {
  readonly mode: "homologation";
  readonly fromName: string;
  readonly fromAddress: string;
  readonly replyTo: string;
  readonly allowedRecipients: readonly string[];
}

export class MailHomologationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailHomologationConfigError";
  }
}

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new MailHomologationConfigError(`Variável obrigatória ausente: ${key}`);
  return value;
}

function normalizedEmail(value: string, key: string): string {
  const normalized = value.trim().toLowerCase();
  if (!emailValido(normalized)) {
    throw new MailHomologationConfigError(`E-mail inválido em ${key}`);
  }
  return normalized;
}

export function loadHomologationMailPolicy(env: Environment): HomologationMailPolicy {
  if (env.MAIL_MODE !== "homologation") {
    throw new MailHomologationConfigError("MAIL_MODE deve ser homologation para habilitar envio");
  }

  const fromName = required(env, "MAIL_FROM_NAME");
  if (/\r|\n/.test(fromName)) {
    throw new MailHomologationConfigError("MAIL_FROM_NAME contém caracteres não permitidos");
  }

  const fromAddress = normalizedEmail(required(env, "MAIL_FROM_ADDRESS"), "MAIL_FROM_ADDRESS");
  const replyTo = normalizedEmail(required(env, "MAIL_REPLY_TO"), "MAIL_REPLY_TO");
  const allowedRecipients = [
    ...new Set(
      required(env, "MAIL_HOMOLOGATION_WHITELIST")
        .split(",")
        .map((value) => normalizedEmail(value, "MAIL_HOMOLOGATION_WHITELIST")),
    ),
  ];

  if (allowedRecipients.length > MAIL_HOMOLOGATION_MAX_RECIPIENTS) {
    throw new MailHomologationConfigError(
      `Whitelist limitada a ${MAIL_HOMOLOGATION_MAX_RECIPIENTS} destinatários`,
    );
  }

  return Object.freeze({
    mode: "homologation",
    fromName,
    fromAddress,
    replyTo,
    allowedRecipients: Object.freeze(allowedRecipients),
  });
}

export function loadConfirmationBaseUrl(env: Environment): string {
  const raw = required(env, "CONFIRMATION_BASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailHomologationConfigError("CONFIRMATION_BASE_URL inválida");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new MailHomologationConfigError(
      "CONFIRMATION_BASE_URL deve ser uma origem HTTPS sem caminho, credenciais, query ou fragmento",
    );
  }
  return url.origin;
}

export function readHomologationSecret(
  env: Environment,
  key: "RESEND_API_KEY" | "RESEND_WEBHOOK_SECRET",
): string {
  const value = required(env, key);
  const expectedPrefix = key === "RESEND_API_KEY" ? "re_" : "whsec_";
  if (!value.startsWith(expectedPrefix)) {
    throw new MailHomologationConfigError(`${key} possui formato inesperado`);
  }
  return value;
}
