import type { MailDelivery, MailReceipt, OutboundMail } from "./message.js";

export interface MailGateway {
  send(message: OutboundMail): Promise<MailReceipt>;
  getStatus(messageId: string): Promise<MailDelivery>;
}

export class MailProviderNaoConfiguradoError extends Error {
  constructor(provider: string) {
    super(`Provedor de e-mail não configurado: ${provider}`);
    this.name = "MailProviderNaoConfiguradoError";
  }
}

export class DestinatarioNaoAutorizadoError extends Error {
  constructor() {
    super("Destinatário fora da whitelist de homologação");
    this.name = "DestinatarioNaoAutorizadoError";
  }
}

export class MailProviderRequestError extends Error {
  constructor(provider: string, operation: string) {
    super(`Falha do provedor ${provider} durante ${operation}`);
    this.name = "MailProviderRequestError";
  }
}

/**
 * Seção 7 — falhas específicas de transporte Gmail com classificação
 * determinística pelo worker. Todas ESPECIALIZAM MailProviderRequestError para
 * preservar o contrato homologado "falha HTTP → erro sanitizado sem corpo",
 * adicionando a categoria exigida pela política de retry. Mensagens contêm
 * APENAS código curto — nunca corpo de resposta, token ou PII.
 */
export class GmailAuthError extends MailProviderRequestError {
  constructor(operation: string) {
    super("GMAIL", `auth inválida durante ${operation} (401/invalid_grant)`);
    this.name = "GmailAuthError";
  }
}

export class GmailAmbiguousError extends MailProviderRequestError {
  constructor(operation: string) {
    super("GMAIL", `resultado ambíguo durante ${operation} (timeout/abort)`);
    this.name = "GmailAmbiguousError";
  }
}

export class GmailRateLimitError extends MailProviderRequestError {
  constructor(operation: string) {
    super("GMAIL", `limite de requisições durante ${operation} (429)`);
    this.name = "GmailRateLimitError";
  }
}

export class GmailPermanentPolicyError extends MailProviderRequestError {
  constructor(operation: string) {
    super("GMAIL", `erro permanente/configuração durante ${operation} (403/domainPolicy)`);
    this.name = "GmailPermanentPolicyError";
  }
}
