import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  GmailAmbiguousError,
  GmailAuthError,
  GmailPermanentPolicyError,
  GmailRateLimitError,
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

/**
 * F14 — Escopos completos do consentimento: envio + identidade OIDC mínima
 * (openid + email) para provar a CONTA Google autorizada (email_verified).
 * Nenhum escopo de leitura de Gmail em nenhuma fase.
 */
export const GMAIL_OAUTH_SCOPES: readonly string[] = [
  GMAIL_SEND_SCOPE,
  "openid",
  "email",
];

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

  /**
   * Emite o state assinado. Um `nonce` externo (F13 — binding one-time
   * start↔callback) pode ser embutido no payload: o MESMO nonce é então
   * exigido no callback via cookie HttpOnly + registro one-time, tornando o
   * state inútil fora do fluxo autenticado que o originou.
   * O payload pode transportar composição com ":" (ex.: binding:verificador
   * PKCE) — o delimitador do state permanece "." e o epoch ms mantém-se sem
   * separadores.
   */
  issue(now: Date = new Date(), nonce?: string): OauthState {
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const nonceEmitido = nonce ?? randomBytes(16).toString("base64url");
    // O payload assinado usa epoch ms (sem pontos): o estado é delimitado por
    // "." e um ISO com milissegundos (12:10:00.000Z) quebraria o split da
    // verificação, invalidando todo state emitido.
    const payload = `${nonceEmitido}.${now.getTime() + this.ttlMs}`;
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

/** Nome do cookie HttpOnly de binding do fluxo OAuth (start ↔ callback). */
export const OAUTH_BINDING_COOKIE = "ic_oauth_binding";

export type OauthBindingStatus = "BOUND" | "MISSING" | "REPLAY" | "EXPIRED";

/**
 * F18 — O registro one-time do binding start↔callback NÃO vive mais em
 * memória de processo: foi migrado para PostgreSQL (`oauth_flow`), que garante
 * consumo atômico one-time entre instâncias serverless (START na instância A,
 * CALLBACK na instância B; corrida resolve exatamente um vencedor).
 * O contrato de implementação vive em apps/api/src/oauth.ts
 * (OauthFlowBindingStore) e a persistência em packages/persistence.
 */

/**
 * Par PKCE (S256) — verificador de alta entropia e seu challenge SHA-256
 * base64url. O verificador permanece server-side (nunca vai à URL); o
 * challenge viaja na authorization URL. Exige que quem troca o código possua
 * o verificador da MESMA sessão que iniciou o fluxo.
 */
export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export function gerarParPkce(): PkcePair {
  // O verificador usa base64url SEM "." (o ":" separa binding:verifier no
  // payload do state assinado); base64url já não contém ":".
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * URLs do fluxo OAuth (start/callback) construídas com escopo mínimo.
 * PKCE S256 e OpenID (nonce OIDC) são incluídos quando fornecidos — a
 * fundação usa sempre PKCE + nonce para endurecer o fluxo server-side.
 */
export function buildAuthorizationUrl(
  config: GmailOauthConfig,
  state: string,
  opcoes: { scopes?: readonly string[]; codeChallenge?: string; oidcNonce?: string } = {},
): string {
  const url = new URL(GMAIL_OAUTH_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (opcoes.scopes ?? GMAIL_OAUTH_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  if (opcoes.codeChallenge) {
    url.searchParams.set("code_challenge", opcoes.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (opcoes.oidcNonce) {
    url.searchParams.set("nonce", opcoes.oidcNonce);
  }
  return url.toString();
}

export const GOOGLE_OIDC_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleAccountIdentity {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Domínio organizacional (Google Workspace "hd") quando presente. */
  readonly hd?: string;
}

/**
 * F14 — Identidade Google verificada do titular do access token (OIDC
 * userinfo, privilégio mínimo: usa o access token já obtido). Erro sanitizado:
 * status HTTP apenas, nunca o corpo.
 */
export async function fetchGoogleAccountIdentity(
  accessToken: string,
  transport: (url: string, token: string) => Promise<{ status: number; json: () => Promise<unknown> }> =
    async (url, token) => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, json: () => response.json() };
    },
): Promise<GoogleAccountIdentity> {
  let payload: { sub?: string; email?: string; email_verified?: boolean | string; hd?: string };
  try {
    const resposta = await transport(GOOGLE_OIDC_USERINFO_ENDPOINT, accessToken);
    if (resposta.status !== 200) {
      throw new OauthIdentityError(
        "IDENTITY_CHECK_FAILED",
        `Verificação de identidade Google falhou (HTTP ${resposta.status}).`,
      );
    }
    payload = (await resposta.json()) as typeof payload;
  } catch (error) {
    if (error instanceof OauthIdentityError) throw error;
    throw new OauthIdentityError("IDENTITY_CHECK_FAILED", "Verificação de identidade Google falhou (rede).");
  }
  if (!payload?.sub || !payload?.email) {
    throw new OauthIdentityError("IDENTITY_INCOMPLETE", "Identidade Google sem sub/email.");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new OauthIdentityError("EMAIL_NOT_VERIFIED", "E-mail Google não verificado.");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: true,
    ...(payload.hd ? { hd: payload.hd } : {}),
  };
}

export class OauthIdentityError extends Error {
  constructor(readonly codigo: string, message: string) {
    super(message);
    this.name = "OauthIdentityError";
  }
}

/**
 * F14 — Derivação compartilhada do fingerprint da CONTA: a partir da
 * identidade Google VERIFICADA (e-mail com email_verified=true, exigido
 * igual a GMAIL_EXPECTED_ACCOUNT), NUNCA do clientId do OAuth client.
 * Usada pelo callback OAuth (persistência) e pelo worker (lookup da conexão)
 * — mesma função, mesma derivação dos dois lados.
 */
export function derivarFingerprintContaGmail(
  fingerprinter: { fingerprint(namespace: string, canonicalValue: string): string },
  emailVerificado: string,
): string {
  return fingerprinter.fingerprint("gmail-account", `gmail:${emailVerificado.trim().toLowerCase()}`);
}

export interface GmailTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
}

/**
 * Troca do authorization code por tokens (server-side). O transport é
 * injetável para testes — nenhum secret aparece em logs ou erros.
 * `codeVerifier` (PKCE) é enviado quando presente — obriga correspondência
 * com o challenge da authorization URL da mesma sessão.
 */
export async function exchangeAuthorizationCode(
  config: GmailOauthConfig,
  code: string,
  transport: (body: URLSearchParams) => Promise<GmailTokenResponse>,
  codeVerifier?: string,
): Promise<GmailTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  if (codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }
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

/** Seção 7 — limite de tempo da chamada de envio (sem dependência externa). */
export const GMAIL_SEND_TIMEOUT_MS = 15_000;

/**
 * FINAL CLOSURE GATE item 3 — extrai APENAS o `reason` curto (ex.:
 * "rateLimitExceeded") do corpo de erro do Google. O corpo NUNCA é
 * propagado, logado ou persistido — apenas esta classificação.
 */
export async function extrairReasonGoogle(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: { errors?: readonly { reason?: string }[] };
    };
    return data?.error?.errors?.[0]?.reason ?? "";
  } catch {
    return "";
  }
}

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
  // Seção 6 — Message-ID determinístico por communication_id (RFC 5322
  // msg-id sem aspas angulares, reservado ao provedor): permite detecção de
  // duplicidade e reconstrução do MIME em casos ambíguos.
  const messageIdentifier = `${message.confirmationId.replace(/[^a-zA-Z0-9]/g, "")}.pf-confirmation@pilot.crtba.org.br`;

  return [
    `From: ${from}`,
    `Reply-To: ${replyTo}`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `Message-ID: <${messageIdentifier}>`,
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
        // Seção 7 — timeout: rede lenta não pode segurar o lease indefinidamente.
        signal: AbortSignal.timeout(GMAIL_SEND_TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout/abort é ambíguo: a requisição pode ter chegado ao Gmail.
      // Classe dedicada para o worker classificar como DELIVERY_UNKNOWN.
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new GmailAmbiguousError("messages.send");
      }
      throw new MailProviderRequestError("GMAIL", "messages.send (rede)");
    }
    if (!response.ok) {
      // Erro sanitizado: classe por status + código curto; corpo da resposta
      // NUNCA é propagado (pode conter PII do payload ou detalhes internos).
      // FINAL CLOSURE GATE item 3 — nem todo 403 é permanente: o `reason`
      // sanitizado do Google decide entre rate-limit (retryable) e política.
      if (response.status === 401) throw new GmailAuthError("messages.send");
      if (response.status === 429) throw new GmailRateLimitError("messages.send");
      if (response.status >= 500) {
        // Piloto: resultado incerto — a requisição pode ter chegado ao Gmail.
        throw new GmailAmbiguousError("messages.send");
      }
      if (response.status === 403) {
        const reason = (await extrairReasonGoogle(response)).toLowerCase();
        if (reason === "ratelimitexceeded" || reason === "userratelimitexceeded") {
          throw new GmailRateLimitError("messages.send");
        }
        // domainPolicy, escopo insuficiente, política administrativa etc.
        throw new GmailPermanentPolicyError("messages.send");
      }
      throw new MailProviderRequestError("GMAIL", `messages.send (HTTP ${response.status})`);
    }
    const data = (await response.json()) as GmailSendResponse;
    if (!data?.id) {
      throw new MailProviderRequestError("GMAIL", "messages.send (resposta sem id)");
    }
    return {
      provider: "GMAIL" as const,
      messageId: data.id,
      ...(data.threadId ? { threadId: data.threadId } : {}),
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
