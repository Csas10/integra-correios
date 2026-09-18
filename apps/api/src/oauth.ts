import { createHmac, randomUUID } from "node:crypto";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  loadGmailOauthConfig,
  OauthStateSigner,
  GMAIL_SEND_SCOPE,
  type GmailTokenResponse,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  type PostgresOperationalRepository,
} from "@integra-correios/persistence";

/**
 * F2 — OAuth do Gmail de ponta a ponta, server-side.
 *
 *  start    → emite state opaco assinado (CSRF) e devolve a URL de consentimento;
 *  callback → valida state, troca code por tokens, CIFRA e persiste a conexão
 *             (oauth_connection) e audita sem secrets.
 *
 * Nenhum token (access/refresh) é devolvido ao browser em nenhuma etapa.
 * A conexão real permanece um gate humano do titular — a rota apenas recebe
 * o callback autorizado por ele.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export class OauthFlowError extends Error {
  constructor(readonly codigo: string, message: string) {
    super(message);
    this.name = "OauthFlowError";
  }
}

function ambiente(): Environment {
  return process.env;
}

export function oauthConfigurado(): boolean {
  return loadGmailOauthConfig(ambiente()) !== undefined;
}

/** Chave de assinatura do state: exigida do ambiente (fail-closed). */
function signer(): OauthStateSigner {
  const chaveB64 = process.env.GMAIL_OAUTH_STATE_KEY?.trim();
  if (!chaveB64) {
    throw new OauthFlowError(
      "STATE_SIGNING_KEY_MISSING",
      "GMAIL_OAUTH_STATE_KEY ausente — assinatura de state OAuth não configurada.",
    );
  }
  const chave = Buffer.from(chaveB64, "base64");
  if (chave.byteLength < 32) {
    throw new OauthFlowError(
      "STATE_SIGNING_KEY_WEAK",
      "GMAIL_OAUTH_STATE_KEY deve conter pelo menos 32 bytes (base64).",
    );
  }
  return new OauthStateSigner(new Uint8Array(chave));
}

/** URL de consentimento + state opaco. O state nunca sai do servidor assinado. */
export function iniciarFluxoOauth(baseUrl: string): { url: string; expiresAt: string } {
  const config = loadGmailOauthConfig(ambiente());
  if (!config) {
    throw new OauthFlowError(
      "OAUTH_NOT_CONFIGURED",
      "Credenciais OAuth ausentes (GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI).",
    );
  }
  const { state, expiresAt } = signer().issue();
  const url = buildAuthorizationUrl(config, state);
  return { url, expiresAt };
}

/**
 * Troca do authorization code por tokens (server-side), com transport
 * injetável para testes (nenhuma rede em teste unitário).
 */
export async function concluirFluxoOauth(
  code: string,
  state: string,
  repository: PostgresOperationalRepository,
  caixa: Aes256GcmSecretBox,
  fingerprinter: HmacSha256Fingerprinter,
  agora: Date = new Date(),
  transport: (body: URLSearchParams) => Promise<GmailTokenResponse> = trocarTokensHttp,
): Promise<{ status: "CONNECTED"; scopes: readonly string[] }> {
  const config = loadGmailOauthConfig(ambiente());
  if (!config) {
    throw new OauthFlowError("OAUTH_NOT_CONFIGURED", "Credenciais OAuth ausentes.");
  }
  if (!signer().verify(state, agora)) {
    throw new OauthFlowError("STATE_INVALID", "State OAuth inválido ou expirado.");
  }
  const tokens = await exchangeAuthorizationCode(config, code, transport);
  const expiraEm = new Date(agora.getTime() + tokens.expiresIn * 1000).toISOString();
  const fingerprint = fingerprinter.fingerprint("gmail-account", config.clientId);
  const connectionId = randomUUID();
  const agoraIso = agora.toISOString();

  await repository.saveOauthConnection({
    connection: {
      id: connectionId,
      provider: "GMAIL",
      accountFingerprint: fingerprint,
      scopes: [GMAIL_SEND_SCOPE],
      accessToken: caixa.seal(tokens.accessToken, "oauth:access"),
      ...(tokens.refreshToken ? { refreshToken: caixa.seal(tokens.refreshToken, "oauth:refresh") } : {}),
      expiresAt: expiraEm,
    },
    auditEvent: {
      id: randomUUID(),
      aggregateType: "OAUTH_CONNECTION",
      aggregateId: connectionId,
      type: "OAUTH_GMAIL_CONNECTED",
      occurredAt: agoraIso,
      metadata: { escopo: GMAIL_SEND_SCOPE },
      eventHash: createEventHash(connectionId, agoraIso),
    },
  });
  return { status: "CONNECTED", scopes: [GMAIL_SEND_SCOPE] };
}

/** Transporte HTTP real para o token endpoint — sem logs de secrets. */
async function trocarTokensHttp(body: URLSearchParams): Promise<GmailTokenResponse> {
  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resposta.ok) {
    // Sanitizado: apenas status HTTP; corpo pode conter detalhes sensíveis.
    throw new OauthFlowError("TOKEN_EXCHANGE_FAILED", `Troca de código falhou (HTTP ${resposta.status}).`);
  }
  const data = (await resposta.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data?.access_token || typeof data.expires_in !== "number") {
    throw new OauthFlowError("TOKEN_EXCHANGE_FAILED", "Resposta de token sem access_token.");
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
  };
}

function createEventHash(id: string, occurredAt: string): string {
  // Mesma cadeia determinística usada pelo pilot/intake (audit-chain HMAC).
  return createHmac("sha256", "audit-chain").update(id).update(occurredAt).digest("hex");
}
