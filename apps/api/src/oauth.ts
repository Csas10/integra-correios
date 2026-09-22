import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildAuthorizationUrl,
  derivarFingerprintContaGmail,
  exchangeAuthorizationCode,
  fetchGoogleAccountIdentity,
  gerarParPkce,
  loadGmailOauthConfig,
  OauthStateSigner,
  OauthIdentityError,
  GMAIL_SEND_SCOPE,
  type GmailTokenResponse,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  type ConsumeOauthFlowBindingCommand,
  type OauthFlowBindingConsumeResult,
  type PostgresOperationalRepository,
  type RegisterOauthFlowBindingCommand,
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

/**
 * Domínio organizacional esperado (Google Workspace "hd"). Opcional: quando
 * configurado, contas fora do domínio são rejeitadas mesmo com e-mail
 * idêntico (defesa em profundidade contra mudança de conta no Google).
 */
export function hdOrganizacionalEsperado(env: Environment = ambiente()): string {
  const hd = env.GMAIL_EXPECTED_HD?.trim().toLowerCase();
  return hd ?? "";
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

/** SHA-256 hex do nonce de binding — o valor bruto NUNCA é persistido/logado. */
function hashDeNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Nonce OIDC por fluxo: prova que o authorization response corresponde à
 * MESMA sessão que iniciou o consentimento (anti replay do código).
 *server-side: o valor bruto nunca é logado; vai apenas à URL de consentimento.
 */
function gerarNonceOidc(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * FINAL CLOSURE GATE item 1 — o state carrega APENAS o nonce de binding
 * opaco (assinado). O code_verifier PKCE NUNCA atravessa o browser: fica
 * CIFRADO (AES-256-GCM) no binding PostgreSQL temporário e é recuperado
 * server-side no consumo atômico. O cookie HttpOnly do fluxo transporta
 * `<bindingNonce>:<operadorHash>` — o hash SHA-256 da identidade do
 * operador do START ancora a sessão (callback divergente → SESSION_MISMATCH).
 */
export function hashOperadorGmail(opToken: string): string {
  return createHash("sha256").update(opToken.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * F18 — Porta de persistência do binding one-time (PostgreSQL).
 * Mantida mínima e específica do fluxo OAuth para permitir injeção nos
 * testes sem banco e sem duplicar a superfície do repositório operacional.
 */
export interface OauthFlowBindingStore {
  registrarBindingOauthFlow(command: RegisterOauthFlowBindingCommand): Promise<void>;
  consumirBindingOauthFlow(command: ConsumeOauthFlowBindingCommand): Promise<OauthFlowBindingConsumeResult>;
}

/** TTL do binding one-time registrado no banco (espelha o cookie, 10 min). */
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * F13/F14/F18 — URL de consentimento + state opaco + binding one-time
 * PERSISTIDO em PostgreSQL (serverless-safe: START na instância A, CALLBACK
 * na instância B). O nonce é devolvido ao chamador (server.ts) para o cookie
 * HttpOnly do fluxo; o banco recebe apenas o SHA-256 + expiração. O callback
 * só é aceito quando state assinado E cookie carregam o MESMO nonce, emitido
 * por um START autenticado, dentro do TTL e não consumido (atomicamente).
 */
export async function iniciarFluxoOauth(
  baseUrl: string,
  bindingStore: OauthFlowBindingStore,
  agora: Date = new Date(),
  opcoes: { caixa: Aes256GcmSecretBox; operadorHash: string },
): Promise<{ url: string; expiresAt: string; bindingNonce: string; operadorHash: string }> {
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
  // Nonce de alta entropia; o MESMO valor vai no state assinado e no cookie,
  // e apenas seu HASH é registrado one-time no banco.
  const bindingNonce = randomBytes(32).toString("base64url");
  // PKCE (S256): o verifier fica CIFRADO no binding PostgreSQL — nunca no
  // state, nunca no browser. O challenge simétrico vai à authorization URL.
  const { codeVerifier, codeChallenge } = gerarParPkce();
  const oidcNonce = gerarNonceOidc();
  const expiraEm = new Date(agora.getTime() + OAUTH_FLOW_TTL_MS);
  await bindingStore.registrarBindingOauthFlow({
    nonceHash: hashDeNonce(bindingNonce),
    codeVerifier: opcoes.caixa.seal(codeVerifier, "oauth:pkce"),
    operadorHash: opcoes.operadorHash,
    expiresAt: expiraEm.toISOString(),
  });
  // State = payload do próprio nonce (opaco, assinado). Nenhum verifier.
  const { state, expiresAt } = signer().issue(agora, bindingNonce);
  const url = buildAuthorizationUrl(config, state, { codeChallenge, oidcNonce });
  return { url, expiresAt, bindingNonce, operadorHash: opcoes.operadorHash };
}

/**
 * F18 — Verificação do binding start↔callback, na ORDEM correta:
 *  1. formato do state;
 *  2. assinatura HMAC (timing-safe);
 *  3. expiração server-side;
 *  4. binding extraído do state assinado;
 *  5. igualdade timing-safe state↔cookie;
 *  6. SOMENTE DEPOIS o consumo atômico no banco (one-time real entre
 *     instâncias). Nada é consumido antes da validação completa.
 * Cookie ausente/divergente/replay/expirado → FAIL (fail-closed).
 * Retorna o code_verifier PKCE transportado no state assinado.
 */
export async function validarBindingState(
  bindingCookie: string | undefined,
  state: string,
  bindingStore: OauthFlowBindingStore,
  caixa: Aes256GcmSecretBox,
  agora: Date = new Date(),
): Promise<string> {
  if (!bindingCookie?.trim()) {
    throw new OauthFlowError("STATE_BINDING_MISSING", "Binding do fluxo OAuth ausente — inicie o fluxo autenticado.");
  }
  const partes = state.split(".");
  if (partes.length !== 3) {
    throw new OauthFlowError("STATE_INVALID", "State OAuth inválido.");
  }
  // O payload do state É o nonce de binding (opaco) — item 1 do closure.
  const bindingNonce = partes[0] ?? "";
  // Cookie do fluxo: <bindingNonce>:<operadorHash> (HttpOnly, SameSite=Lax).
  const separadorCookie = bindingCookie.indexOf(":");
  if (separadorCookie <= 0 || separadorCookie === bindingCookie.length - 1) {
    throw new OauthFlowError("STATE_BINDING_MISMATCH", "Binding do fluxo OAuth inválido.");
  }
  const cookieNonce = bindingCookie.slice(0, separadorCookie);
  const operadorHash = bindingCookie.slice(separadorCookie + 1);
  // Assinatura + expiração ANTES de qualquer acesso à persistência: um state
  // inválido NUNCA consome o binding (evita DoS de consumo por forged states).
  if (!signer().verify(state, agora)) {
    throw new OauthFlowError("STATE_INVALID", "State OAuth inválido ou expirado.");
  }
  // Igualdade timing-safe entre o nonce do state e o cookie do fluxo.
  const a = Buffer.from(bindingNonce);
  const b = Buffer.from(cookieNonce);
  if (a.length !== b.length || !timingSafeIgual(a, b)) {
    throw new OauthFlowError("STATE_BINDING_MISMATCH", "State não corresponde ao fluxo iniciado.");
  }
  // Último passo: consumo ONE-TIME atômico no banco, EXIGINDO o MESMO
  // operador do START. Exatamente um callback vence; replay, expiração,
  // nonce desconhecido e sessão divergente falham fechados.
  const bindingResultado = await bindingStore.consumirBindingOauthFlow({
    nonceHash: hashDeNonce(bindingNonce),
    operadorHash,
    now: agora.toISOString(),
  });
  switch (bindingResultado.status) {
    case "REPLAY":
      throw new OauthFlowError("STATE_REPLAY", "Binding do fluxo OAuth já utilizado.");
    case "EXPIRED":
      throw new OauthFlowError("STATE_EXPIRED", "Binding do fluxo OAuth expirado — inicie o fluxo novamente.");
    case "SESSION_MISMATCH":
      throw new OauthFlowError("STATE_SESSION_MISMATCH", "Callback de sessão operacional divergente do START.");
    case "CONSUMED":
      if (!bindingResultado.codeVerifierSealed) {
        throw new OauthFlowError("STATE_INVALID", "Binding sem code_verifier PKCE.");
      }
      // O verifier sai do BANCO (cifrado) apenas aqui — server-side.
      return new TextDecoder().decode(caixa.open(bindingResultado.codeVerifierSealed, "oauth:pkce"));
    default:
      throw new OauthFlowError("STATE_BINDING_MISSING", "Binding não originado por um START autorizado.");
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
  // Defesa em profundidade: domínio organizacional (hd) quando configurado.
  const hdEsperado = hdOrganizacionalEsperado();
  if (hdEsperado && (identidade.hd ?? "").trim().toLowerCase() !== hdEsperado) {
    throw new OauthFlowError(
      "BLOCKED_HD_MISMATCH",
      "Conta autorizada fora do domínio organizacional esperado. Conexão rejeitada.",
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
  // F18 + closure item 1: binding one-time start↔callback persistido em
  // PostgreSQL (anti login-CSRF / account injection, serverless-safe). O
  // code_verifier PKCE é recuperado do binding CIFRADO no banco — nunca
  // do state/browser.
  const codeVerifier = await validarBindingState(bindingCookie, state, repository, caixa, agora);
  const tokens = await exchangeAuthorizationCode(config, code, transport, codeVerifier);
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
