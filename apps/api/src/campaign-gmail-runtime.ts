/**
 * SLICE-03C.2B1A — RUNTIME GMAIL REAL DA CAMPANHA PF (LOCAL, STRICT ZERO SEND).
 *
 * Fecha a última lacuna de código entre o Slice-03C.2A (CI-verde) e a futura
 * configuração OAuth operacional: transporte Gmail real, resolução da conexão
 * OAuth persistida, descriptografia controlada do access token, refresh quando
 * necessário, persistência cifrada do token renovado e composição do
 * GmailMailGateway real conectado ao ProvedorGmailCampanha.
 *
 * NENHUMA chamada real Google/Gmail é autorizada neste gate: este módulo não
 * dispara rede por si — o transport só é invocado pelo gateway durante um
 * envio armado (que segue fail-closed pelas políticas de produção).
 *
 * Contratos homologados REUTILIZADOS (estratégia A — helper neutro de domínio
 * OAuth; sem dependência entre apps/api e apps/worker; execução, state machine
 * e CONTROLLED_GMAIL_TEST do worker NÃO são reutilizados):
 *   oauth_connection → conta esperada → fingerprint canônico → conexão GMAIL
 *   ativa → decrypt access token → validade/expiração → decrypt refresh token
 *   → refresh (porta injetável) → persistência CIFRADA (refreshOauthAccessToken)
 *   → token somente em memória. PostgreSQL permanece autoridade durável.
 *
 * Fail-closed: sem OAuth config completa, GMAIL_EXPECTED_ACCOUNT válido, chaves
 * de 32 bytes ou DATA_ENCRYPTION_KEY_VERSION, o resolver retorna undefined —
 * NUNCA constrói criptografia/fingerprint com chave vazia, NUNCA acessa o
 * Google, NUNCA expõe segredo.
 *
 * Classificação: falhas de config/conexão/decrypt/refresh NUNCA são ambiguas
 * nem rejeições de messages.send — lançam CampanhaTokenResolutionError
 * (sanitizado, sem token/header), mapeado pelo provider como FALHA_PRE_PROVIDER.
 *
 * Concorrência: single-flight APENAS in-process (Promise no closure). NÃO há
 * garantia exatamente-uma-vez cross-instance serverless — débito registrado
 * (DEFERRED_BEFORE_LIMITED_BATCH, resolvido antes do lote limitado 03C.2C).
 */
import {
  derivarFingerprintContaGmail,
  GmailHttpTransport,
  loadGmailOauthConfig,
  MailProviderRequestError,
  type GmailOauthConfig,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  PostgresOperationalRepository,
  type SqlPool,
} from "@integra-correios/persistence";

/** Erro tipado sanitizado da resolução de token — SEMPRE FALHA_PRE_PROVIDER
 * (nenhuma mensagem Gmail foi tentada; nunca AMBIGUO; GMAIL_SEND_CALLS=0).
 * A mensagem NÃO contém token, refresh token, Authorization header ou segredo. */
export class CampanhaTokenResolutionError extends Error {
  constructor(readonly motivo: string) {
    super("resolução de token de campanha indisponível (" + motivo + ")");
    this.name = "CampanhaTokenResolutionError";
  }
}

export interface DependenciasRuntimeGmailCampanha {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pool: SqlPool;
  /** Porta de refresh injetável (testes usam fake; default = GmailHttpTransport). */
  readonly portaRefresh?: (
    config: GmailOauthConfig,
    refreshToken: string,
  ) => Promise<{ access_token: string; expires_in: number }>;
  /** Transporte de envio injetável (testes usam fake; default = GmailHttpTransport). */
  readonly portaTransporte?: (message: OutboundMail, accessToken: string) => Promise<MailReceipt>;
  readonly agoraMs?: () => number;
  /** Margem mínima para considerar o access token válido sem refresh. */
  readonly margemMinimaMs?: number;
}

export interface RuntimeGmailCampanha {
  /** Resolvedor do access token (contrato do GmailMailGateway). */
  readonly loadAccessToken: () => Promise<string | undefined>;
  /** Transporte no formato exigido pelo construtor do gateway (função). */
  readonly transport: (message: OutboundMail, accessToken: string) => Promise<MailReceipt>;
  /** Instrumentação read-only para testes (contadores do closure). */
  readonly metricas: {
    readonly leiturasConexao: () => number;
    readonly descriptografias: () => number;
    readonly refreshes: () => number;
    readonly chamadasTransporte: () => number;
  };
}

const MARGEM_PADRAO_MS = 60_000;
const decoder = new TextDecoder();

export function criarCampanhaGmailRuntime(
  dependencias: DependenciasRuntimeGmailCampanha,
): RuntimeGmailCampanha {
  const { env, pool } = dependencias;
  const agora = dependencias.agoraMs ?? (() => Date.now());
  const margem = dependencias.margemMinimaMs ?? MARGEM_PADRAO_MS;

  let leiturasConexao = 0;
  let descriptografias = 0;
  let refreshes = 0;
  let chamadasTransporte = 0;

  // ---- validação fail-closed da configuração (NUNCA chave vazia) ----
  const config = loadGmailOauthConfig(env);
  const esperada = env.GMAIL_EXPECTED_ACCOUNT?.trim().toLowerCase() ?? "";
  let accountFingerprint = "";
  let caixa: Aes256GcmSecretBox | undefined;
  if (config && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(esperada)) {
    try {
      const fingerprinter = new HmacSha256Fingerprinter(
        Buffer.from(env.DOCUMENT_FINGERPRINT_KEY_BASE64 ?? "", "base64"),
      );
      accountFingerprint = derivarFingerprintContaGmail(fingerprinter, esperada);
      if (!env.DATA_ENCRYPTION_KEY_VERSION?.trim()) {
        caixa = undefined;
      } else {
        caixa = new Aes256GcmSecretBox(
          Buffer.from(env.DATA_ENCRYPTION_KEY_BASE64 ?? "", "base64"),
          env.DATA_ENCRYPTION_KEY_VERSION.trim(),
        );
      }
    } catch {
      // chave ausente/tamanho errado/versão ausente ⇒ fail-closed
      caixa = undefined;
      accountFingerprint = "";
    }
  }

  const repositorio = new PostgresOperationalRepository(pool);
  const transportBase: (message: OutboundMail, accessToken: string) => Promise<MailReceipt> =
    dependencias.portaTransporte ??
    ((message, accessToken) => new GmailHttpTransport().send(message, accessToken));
  const transport = async (message: OutboundMail, accessToken: string): Promise<MailReceipt> => {
    chamadasTransporte += 1;
    return transportBase(message, accessToken);
  };

  // Single-flight IN-PROCESS (sem garantia cross-instance — débito 03C.2C).
  let refreshEmVoo: Promise<string> | undefined;

  const loadAccessToken = async (): Promise<string | undefined> => {
    // Fail-closed determinístico: config/chaves ausentes ⇒ undefined
    // (pré-provider, zero rede, zero decrypt, zero leitura de conexão).
    if (!config || !accountFingerprint || !caixa) return undefined;
    if (refreshEmVoo) return refreshEmVoo;
    const conexao = await repositorio.loadGmailConnection(accountFingerprint);
    leiturasConexao += 1;
    // Sem conexão ativa/na conta esperada (inexistente, divergente ou
    // revogada) ⇒ undefined (fail-closed; decrypt=0, refresh=0).
    if (!conexao) return undefined;
    const expiraEm = conexao.expiresAt ? Date.parse(conexao.expiresAt) : 0;
    if (expiraEm > agora() + margem) {
      try {
        descriptografias += 1;
        const token = decoder.decode(caixa.open(conexao.accessToken, "oauth:access"));
        if (!token) throw new Error("token vazio");
        return token;
      } catch {
        throw new CampanhaTokenResolutionError("DECRYPT_INDISPONIVEL");
      }
    }
    if (!conexao.refreshToken) {
      throw new CampanhaTokenResolutionError("REFRESH_TOKEN_AUSENTE");
    }
    refreshEmVoo = (async () => {
      let refreshEmClaro: string;
      try {
        descriptografias += 1;
        refreshEmClaro = decoder.decode(caixa!.open(conexao.refreshToken!, "oauth:refresh"));
      } catch {
        throw new CampanhaTokenResolutionError("DECRYPT_INDISPONIVEL");
      }
      let renovado: { access_token: string; expires_in: number };
      try {
        refreshes += 1;
        renovado = await (dependencias.portaRefresh
          ? dependencias.portaRefresh(config, refreshEmClaro)
          : new GmailHttpTransport().refreshAccessToken(config, refreshEmClaro).catch((error) => {
              if (error instanceof MailProviderRequestError) {
                throw new CampanhaTokenResolutionError("REFRESH_INDISPONIVEL");
              }
              throw error;
            }));
      } catch (error) {
        if (error instanceof CampanhaTokenResolutionError) throw error;
        throw new CampanhaTokenResolutionError("REFRESH_INDISPONIVEL");
      }
      const novoExpiraEm = new Date(agora() + renovado.expires_in * 1000).toISOString();
      const envelope = caixa!.seal(renovado.access_token, "oauth:access");
      try {
        // Contrato homologado: persistência CIFRADA do novo token (nunca
        // plaintext; PostgreSQL autoridade durável; CAS por id+fingerprint).
        await repositorio.refreshOauthAccessToken({
          connectionId: conexao.id,
          accountFingerprint,
          accessToken: envelope,
          expiresAt: novoExpiraEm,
        });
      } catch {
        throw new CampanhaTokenResolutionError("REFRESH_PERSISTENCIA_INDISPONIVEL");
      }
      return renovado.access_token;
    })();
    try {
      return await refreshEmVoo;
    } finally {
      refreshEmVoo = undefined;
    }
  };

  return {
    loadAccessToken,
    transport,
    metricas: {
      leiturasConexao: () => leiturasConexao,
      descriptografias: () => descriptografias,
      refreshes: () => refreshes,
      chamadasTransporte: () => chamadasTransporte,
    },
  };
}
