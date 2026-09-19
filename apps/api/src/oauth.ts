import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildAuthorizationUrl,
  derivarFingerprintContaGmail,
  exchangeAuthorizationCode,
  fetchGoogleAccountIdentity,
  loadGmailOauthConfig,
  OauthStateSigner,
  OauthBindingStore,
  OauthIdentityError,
  GMAIL_SEND_SCOPE,
  type GmailTokenResponse,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  type PostgresOperationalRepository,
} from "@integra-correios/persistence";

/**
 * F2/F13/F14 — OAuth do Gmail de ponta a ponta, server-side.
 *
 *  start    (OPERATOR) → emite state opaco assinado + nonce de binding
 *                         (cookie HttpOnly do fluxo) e devolve a URL de
 *                         consentimento;
 *  callback (público)  → exige cookie de binding correspondente ao state
 *                         (anti login-CSRF/account injection), valida
 *                         assinatura/expiração, troca code por tokens,
 *                         VERIFICA a identidade Google (OIDC, email_verified)
 *                         contra GMAIL_EXPECTED_ACCOUNT, e somente então
 *                         CIFRA e persiste a conexão (oauth_connection),
 *                         auditando sem secrets.
 *
 * Conta divergente → BLOCKED_ACCOUNT_MISMATCH: NENHUM token é persistido.
 * Nenhum token (access/refresh) é devolvido ao browser em nenhuma etapa.
 * A segurança OAuth é da aplicação — não depende de Vercel SSO.
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

/**
 * F13 — Registro one-time compartilhado do processo (nonce de binding).
 * Instância por processo: em serverless multi-instância o registro deve
 * migrar a um store compartilhado antes do fluxo LIVE (limitação documentada).
 * Exportado para os testes de regressão exercitarem o MESMO registro usado
 * pelo fluxo (start/callback), sem duplicar estado.
 */
export const fluxoOauthBinding = new OauthBindingStore();

export function oauthConfigurado(): boolean {
  return loadGmailOauthConfig(ambiente()) !== undefined;
}

/**
 * F14 — Conta Gmail institucional esperada (não secreta). Fail-closed:
 * sem GMAIL_EXPECTED_ACCOUNT no ambiente, NENHUMA conexão pode ser aceita —
 * a identidade autorizada é condição de aceitação, não opcional.
 */
export function contaGmailEsperada(env: Environment = ambiente()): string {
  const esperada = env.GMAIL_EXPECTED_ACCOUNT?.trim().toLowerCase();
  return esperada ?? "";
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

/**
 * F13/F14 — URL de consentimento + state opaco + nonce de binding one-time.
 * O nonce é devolvido ao chamador (server.ts) para ser gravado no cookie
 * HttpOnly do fluxo OAuth e registrado como pendente: o callback só é aceito
 * quando state assinado E cookie carregam o MESMO nonce, emitido por um START
 * autenticado, dentro do TTL e não consumido.
 */
export function iniciarFluxoOauth(
  baseUrl: string,
): { url: string; expiresAt: string; bindingNonce: string } {
  const config = loadGmailOauthConfig(ambiente());
  if (!config) {
    throw new OauthFlowError(
      "OAUTH_NOT_CONFIGURED",
      "Credenciais OAuth ausentes (GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI).",
    );
  }
  if (!contaGmailEsperada()) {
    throw new OauthFlowError(
      "EXPECTED_ACCOUNT_MISSING",
      "GMAIL_EXPECTED_ACCOUNT ausente — nenhuma conta pode ser autorizada sem alvo explícito.",
    );
  }
  // O MESMO nonce é embutido no state assinado e registrado one-time: a
  // verificação do callback compara assinatura + TTL + binding não consumido.
  const bindingNonce = fluxoOauthBinding.issue();
  const { state, expiresAt } = signer().issue(new Date(), bindingNonce);
  const url = buildAuthorizationUrl(config, state);
  return { url, expiresAt, bindingNonce };
}

/**
 * F13 — Verificação do binding start↔callback:
 *  1. binding one-time registrado por um START autenticado (BOUND), com
 *     replay (REPLAY) e expiração (EXPIRED/ausente) falhando fechados;
 *  2. state assinado pela instalação e dentro do TTL;
 *  3. cookie do fluxo com o MESMO nonce do state (tempo constante).
 * Cookie ausente/divergente/replay → FAIL (callback sem START autenticado).
 */
export function validarBindingState(bindingCookie: string | undefined, state: string, agora: Date = new Date()): void {
  if (!bindingCookie?.trim()) {
    throw new OauthFlowError("STATE_BINDING_MISSING", "Binding do fluxo OAuth ausente — inicie o fluxo autenticado.");
  }
  const partes = state.split(".");
  const nonce = partes[0] ?? "";
  if (!nonce) {
    throw new OauthFlowError("STATE_INVALID", "State OAuth inválido.");
  }
  const bindingStatus = fluxoOauthBinding.consume(nonce, agora);
  if (bindingStatus === "REPLAY") {
    throw new OauthFlowError("STATE_REPLAY", "Binding do fluxo OAuth já utilizado.");
  }
  if (bindingStatus === "EXPIRED") {
    throw new OauthFlowError("STATE_EXPIRED", "Binding do fluxo OAuth expirado — inicie o fluxo novamente.");
  }
  if (bindingStatus !== "BOUND") {
    throw new OauthFlowError("STATE_BINDING_MISSING", "Binding não originado por um START autorizado.");
  }
  // Consumido com sucesso: agora assinatura + TTL do state + igualdade com o
  // cookie do fluxo (tempo constante). Qualquer falha descarta o nonce.
  try {
    if (!signer().verify(state, agora)) {
      throw new OauthFlowError("STATE_INVALID", "State OAuth inválido ou expirado.");
    }
    const a = Buffer.from(nonce);
    const b = Buffer.from(bindingCookie.trim());
    if (a.length !== b.length || !timingSafeIgual(a, b)) {
      throw new OauthFlowError("STATE_BINDING_MISMATCH", "State não corresponde ao fluxo iniciado.");
    }
  } catch (error) {
    // Falha pós-consumo marca o nonce como replay — ninguém reaproveita.
    fluxoOauthBinding.consume(nonce, agora);
    throw error;
  }
}

function timingSafeIgual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * F14 — Identidade Google verificada + comparação EXATA com a conta esperada.
 * Divergente → BLOCKED_ACCOUNT_MISMATCH (nenhum token persistido).
 * email_verified falso → FAIL.
 */
export async function verificarContaAutorizada(
  accessToken: string,
  transport?: Parameters<typeof fetchGoogleAccountIdentity>[1],
): Promise<{ sub: string; email: string }> {
  const esperada = contaGmailEsperada();
  if (!esperada) {
    throw new OauthFlowError("EXPECTED_ACCOUNT_MISSING", "GMAIL_EXPECTED_ACCOUNT ausente.");
  }
  const identidade = await fetchGoogleAccountIdentity(accessToken, transport);
  const normalizada = identidade.email.trim().toLowerCase();
  if (normalizada !== esperada) {
    // Auditoria/erro sanitizados: NUNCA ecoa o e-mail apresentado.
    throw new OauthFlowError(
      "BLOCKED_ACCOUNT_MISMATCH",
      "Conta autorizada não é a conta institucional esperada. Conexão rejeitada.",
    );
  }
  return { sub: identidade.sub, email: normalizada };
}

/**
 * Troca do authorization code por tokens (server-side), com transportes
 * injetáveis para testes (nenhuma rede em teste unitário).
 */
export async function concluirFluxoOauth(
  code: string,
  state: string,
  bindingCookie: string | undefined,
  repository: PostgresOperationalRepository,
  caixa: Aes256GcmSecretBox,
  fingerprinter: HmacSha256Fingerprinter,
  agora: Date = new Date(),
  transport: (body: URLSearchParams) => Promise<GmailTokenResponse> = trocarTokensHttp,
  identityTransport?: Parameters<typeof fetchGoogleAccountIdentity>[1],
): Promise<{ status: "CONNECTED"; scopes: readonly string[] }> {
  const config = loadGmailOauthConfig(ambiente());
  if (!config) {
    throw new OauthFlowError("OAUTH_NOT_CONFIGURED", "Credenciais OAuth ausentes.");
  }
  // F13: binding one-time start↔callback (anti login-CSRF / account injection).
  validarBindingState(bindingCookie, state, agora);
  const tokens = await exchangeAuthorizationCode(config, code, transport);
  // F14: identidade verificada ANTES de persistir qualquer token.
  const identidade = await verificarContaAutorizada(tokens.accessToken, identityTransport);
  const expiraEm = new Date(agora.getTime() + tokens.expiresIn * 1000).toISOString();
  // F14: fingerprint deriva da IDENTIDADE VERIFICADA (e-mail com
  // email_verified comprovado, igual à conta esperada) — nunca do clientId.
  const fingerprint = derivarFingerprintContaGmail(fingerprinter, identidade.email);
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
      // Sanitizado: nenhum e-mail, sub ou token em auditoria.
      metadata: { contaVerificada: true, escopo: GMAIL_SEND_SCOPE },
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

// Reexport para o server usar o mesmo tipo de erro de identidade.
export { OauthIdentityError };
