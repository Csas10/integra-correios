import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MailProviderNaoConfiguradoError,
  type MailGateway,
} from "../domain/gateway.js";
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
