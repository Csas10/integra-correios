import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MailProviderNaoConfiguradoError,
  MailProviderRequestError,
  type MailGateway,
} from "../domain/gateway.js";
import { PILOT_SENDER } from "../templates/pf-pilot.js";
import type {
  MailDelivery,
  MailProvider,
  MailReceipt,
  OutboundMail,
} from "../domain/message.js";

/**
 * Estado técnico do fluxo OAuth do Gmail institucional.
 *
 * NOT_CONNECTED          — nenhuma conexão salva para a conta;
 * CONFIGURATION_REQUIRED — credenciais OAuth ausentes no ambiente;
 * CONNECTED              — conexão válida persistida (tokens cifrados).
 *
 * A conexão REAL é realizada pelo titular da conta em gate humano separado —
 * nunca autonomamente pelo agente.
 */
export type GmailOauthStatus =
  | "CONFIGURATION_REQUIRED"
  | "NOT_CONNECTED"
  | "CONNECTED";

/** Escopo mínimo da fase: somente envio. Sem leitura de inbox. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GMAIL_OAUTH_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_OAUTH_TOKEN_ENDPOINT =
  "https://oauth2.googleapis.com/token";

type Environment = Readonly<Record<string, string | undefined>>;

export interface GmailOauthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export class GmailOauthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailOauthConfigError";
  }
}

/**
 * Lê as credenciais OAuth do ambiente. Falha fechada: ausência de qualquer
 * variável significa CONFIGURATION_REQUIRED — nunca credencial parcial.
 */
export function loadGmailOauthConfig(env: Environment): GmailOauthConfig | undefined {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GMAIL_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}

/**
 * Estado autoritativo da conexão para a UI. NÃO consulta a conta real e NÃO
 * conecta nada — apenas reflete configuração + persistência.
 */
export function oauthStatusFromEnvironment(
  env: Environment,
  connected: boolean,
): GmailOauthStatus {
  if (!loadGmailOauthConfig(env)) return "CONFIGURATION_REQUIRED";
  return connected ? "CONNECTED" : "NOT_CONNECTED";
}

/** Par state↔verifier do CSRF do OAuth (state opaco assinado). */
export interface OauthState {
  readonly state: string;
  readonly expiresAt: string;
}

/**
 * Emissor de state com HMAC server-side: o state emitido embute expiração e
 * é verificável sem persistência adicional (padrão stateless assinado).
 * CSRF: o callback só é aceito com state emitido por esta instalação e
 * ainda válido.
 */
export class OauthStateSigner {
  constructor(
    private readonly secret: Uint8Array,
    private readonly ttlMs: number = 10 * 60 * 1000,
  ) {}

  issue(now: Date = new Date()): OauthState {
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const nonce = randomBytes(16).toString("base64url");
    // O payload assinado usa epoch ms (sem pontos): o estado é delimitado por
    // "." e um ISO com milissegundos (12:10:00.000Z) quebraria o split da
    // verificação, invalidando todo state emitido.
    const payload = `${nonce}.${now.getTime() + this.ttlMs}`;
    const signature = this.sign(payload);
    return { state: `${payload}.${signature}`, expiresAt };
  }

  verify(state: string, now: Date = new Date()): boolean {
    const parts = state.split(".");
    if (parts.length !== 3) return false;
    const [nonce, expiresAtMs, signature] = parts as [string, string, string];
    const payload = `${nonce}.${expiresAtMs}`;
    const expected = this.sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const expiry = Number(expiresAtMs);
    if (!Number.isSafeInteger(expiry) || expiry <= now.getTime()) return false;
    return true;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

/** URLs do fluxo OAuth (start/callback) construídas com escopo mínimo. */
export function buildAuthorizationUrl(
  config: GmailOauthConfig,
  state: string,
): string {
  const url = new URL(GMAIL_OAUTH_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SEND_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GmailTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
}

/**
 * Troca do authorization code por tokens (server-side). O transport é
 * injetável para testes — nenhum secret aparece em logs ou erros.
 */
export async function exchangeAuthorizationCode(
  config: GmailOauthConfig,
  code: string,
  transport: (body: URLSearchParams) => Promise<GmailTokenResponse>,
): Promise<GmailTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  return transport(body);
}

/**
 * GmailMailGateway — adapter real atrás do contrato MailGateway.
 *
 * HARD GATE: REAL_SEND_ENABLED=false (default) mantém o envio REAL bloqueado
 * mesmo com OAuth configurado. O browser não pode alterar este flag: ele é
 * lido do ambiente do processo, server-side.
 *
 * A chamada HTTP ao Gmail é delegada a um transport injetável para testes;
 * nesta fase nenhum transport de rede é instanciado por padrão.
 */
export class GmailMailGateway implements MailGateway {
  readonly #realSendEnabled: boolean;

  constructor(
    private readonly transport: ((message: OutboundMail, accessToken: string) => Promise<MailReceipt>) | undefined,
    private readonly loadAccessToken: () => Promise<string | undefined>,
    private readonly clock: () => Date = () => new Date(),
    env: Environment = process.env,
  ) {
    this.#realSendEnabled = env.REAL_SEND_ENABLED === "true";
  }

  /** Fail-closed: sem transport, sem token, ou REAL_SEND_ENABLED=false → erro. */
  async send(message: OutboundMail): Promise<MailReceipt> {
    if (!this.#realSendEnabled) {
      throw new MailProviderNaoConfiguradoError(
        "GMAIL (REAL_SEND_ENABLED=false — envio real bloqueado nesta fase)",
      );
    }
    if (!this.transport) {
      throw new MailProviderNaoConfiguradoError("GMAIL (transport não configurado)");
    }
    const accessToken = await this.loadAccessToken();
    if (!accessToken) {
      throw new MailProviderNaoConfiguradoError("GMAIL (conta não conectada)");
    }
    return this.transport(message, accessToken);
  }

  async getStatus(_messageId: string): Promise<MailDelivery> {
    throw new MailProviderNaoConfiguradoError(
      "GMAIL (consulta de entrega não habilitada nesta fase)",
    );
  }

  /** Visibilidade para testes/worker: o envio real segue bloqueado? */
  get realSendEnabled(): boolean {
    return this.#realSendEnabled;
  }
}

export type MailProvider_ = MailProvider;

// ============================================================================
// Transporte real do Gmail — MIME RFC 2822 + messages.send.
// Implementado nesta fase; executado SOMENTE quando REAL_SEND_ENABLED=true
// (GATE 1) e o lote estiver ATIVO (GATE 2), com credenciais do titular.
// ============================================================================

export const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailSendResponse {
  readonly id: string;
  readonly threadId?: string;
}

export interface GmailTokenRefreshResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

/**
 * Composição MIME multipart/alternative (text + html) RFC 2045/2822.
 * Headers sanitizados: CRLF proibido em from/replyTo/to/subject (header
 * injection); subject em RFC 2047 quando contém não-ASCII.
 */
export function composeMimeMessage(message: OutboundMail): string {
  const headerSanitize = (valor: string): string => {
    if (/[\r\n]/.test(valor)) throw new Error("Cabeçalho MIME inválido (CRLF detectado)");
    return valor;
  };
  const from = headerSanitize(`${PILOT_SENDER.name} <${PILOT_SENDER.address}>`);
  const replyTo = headerSanitize(message.replyTo);
  const to = headerSanitize(message.to);
  const subject = headerSanitize(message.subject);
  const subjectEncoded = /^[-\w .,:;()!\u00C0-\u024F]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const boundary = `ic-${message.confirmationId.replace(/[^a-zA-Z0-9]/g, "")}-${randomBytes(8).toString("hex")}`;

  return [
    `From: ${from}`,
    `Reply-To: ${replyTo}`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Integra-Confirmation-Id: ${headerSanitize(message.confirmationId)}`,
    `X-Integra-Template-Version: ${headerSanitize(message.templateVersion)}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.textBody,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.htmlBody,
    "",
    `--${boundary}--`,
  ].join("\r\n");
}

/**
 * Transporte HTTP real para o Gmail API. Nenhuma credencial entra em logs,
 * erros ou receipts — apenas códigos curtos determinísticos.
 */
export class GmailHttpTransport {
  async send(message: OutboundMail, accessToken: string): Promise<MailReceipt> {
    const mime = composeMimeMessage(message);
    const body = JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") });
    let response: Response;
    try {
      response = await fetch(GMAIL_SEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch {
      throw new MailProviderRequestError("GMAIL", "messages.send (rede)");
    }
    if (!response.ok) {
      // Erro sanitizado: status + código curto; corpo da resposta NUNCA é
      // propagado (pode conter PII do payload ou detalhes internos).
      throw new MailProviderRequestError("GMAIL", `messages.send (HTTP ${response.status})`);
    }
    const data = (await response.json()) as GmailSendResponse;
    if (!data?.id) {
      throw new MailProviderRequestError("GMAIL", "messages.send (resposta sem id)");
    }
    return {
      provider: "GMAIL" as const,
      messageId: data.id,
      acceptedAt: new Date().toISOString(),
    };
  }

  /** Refresh do access token via refresh_token (server-side, sem logs). */
  async refreshAccessToken(
    config: GmailOauthConfig,
    refreshToken: string,
  ): Promise<GmailTokenRefreshResponse> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    let response: Response;
    try {
      response = await fetch(GMAIL_OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new MailProviderRequestError("GMAIL", "token.refresh (rede)");
    }
    if (!response.ok) {
      throw new MailProviderRequestError("GMAIL", `token.refresh (HTTP ${response.status})`);
    }
    const data = (await response.json()) as GmailTokenRefreshResponse;
    if (!data?.access_token) {
      throw new MailProviderRequestError("GMAIL", "token.refresh (resposta sem access_token)");
    }
    return data;
  }
}
