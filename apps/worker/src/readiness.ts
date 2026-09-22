import { loadGmailOauthConfig, oauthStatusFromEnvironment } from "@integra-correios/mail";

/**
 * READINESS CONTRACT — estados por subsistema, legíveis pela UI, SEM secrets.
 *
 * Estados permitidos: READY | DISABLED | CONFIGURATION_REQUIRED |
 * BLOCKED_EXTERNAL | ERROR.
 *
 * BLOCKED_EXTERNAL = a capacidade interna está implementada, mas depende de
 * credencial/conta/autorização humana externa (ex.: OAuth do titular).
 * DISABLED = deliberadamente desligado por política (ex.: PPN, envio real).
 */

export type ReadinessStatus =
  | "READY"
  | "DISABLED"
  | "CONFIGURATION_REQUIRED"
  | "BLOCKED_EXTERNAL"
  | "EXECUTED"
  | "ERROR";

export interface ReadinessItem {
  readonly name: string;
  readonly status: ReadinessStatus;
  /** Explicação curta, sem valores de configuração. */
  readonly detail: string;
  /** Ação humana única necessária quando BLOCKED_EXTERNAL/CONFIGURATION_REQUIRED. */
  readonly requiredAction?: string;
}

export interface ReadinessReport {
  readonly database: ReadinessItem;
  readonly cryptography: ReadinessItem;
  readonly intake: ReadinessItem;
  readonly persistence: ReadinessItem;
  readonly outbox: ReadinessItem;
  readonly worker: ReadinessItem;
  readonly gmailTransport: ReadinessItem;
  readonly gmailOauth: ReadinessItem;
  readonly realSend: ReadinessItem;
  readonly ppn: ReadinessItem;
  /** Modo conceitual do motor único. */
  readonly executionMode: "PREFLIGHT" | "DRY_RUN" | "LIVE_PILOT";
}

type Environment = Readonly<Record<string, string | undefined>>;

function item(
  name: string,
  status: ReadinessStatus,
  detail: string,
  requiredAction?: string,
): ReadinessItem {
  return requiredAction === undefined
    ? { name, status, detail }
    : { name, status, detail, requiredAction };
}

/**
 * Avalia DATABASE (conectividade) e PERSISTENCE (migrations/roles aplicadas).
 * Erros são normalizados para ERROR/BLOCKED_EXTERNAL sem ecoar o DSN.
 */
export async function avaliarDatabase(
  sondar: () => Promise<boolean>,
): Promise<ReadinessItem> {
  try {
    return (await sondar())
      ? item("Database", "READY", "Conectividade PostgreSQL verificada.")
      : item(
          "Database",
          "BLOCKED_EXTERNAL",
          "DATABASE_URL ausente ou inacessível.",
          "Configurar DATABASE_URL (PostgreSQL 16) no ambiente do serviço.",
        );
  } catch {
    return item(
      "Database",
      "ERROR",
      "Falha ao sondar o banco (detalhes suprimidos).",
      "Verificar DATABASE_URL e rede para o PostgreSQL.",
    );
  }
}

/**
 * Readiness completo a partir do ambiente. `sondarDatabase` injeta a checagem
 * real (SELECT 1) para que este módulo permaneça puro e testável.
 * `lerLedgerEnvioReal` injeta a consulta ao ledger de auditoria que detecta
 * PF_COMMUNICATION_ACCEPTED persistido em modo LIVE_PILOT — evidência de que
 * um envio real já aconteceu. Sem banco (ou sem prova), permanece falso.
 */
export async function avaliarReadiness(
  env: Environment,
  sondarDatabase: () => Promise<boolean>,
  lerConexaoOauth?: () => Promise<boolean>,
  lerLedgerEnvioReal?: () => Promise<boolean>,
): Promise<ReadinessReport> {
  // F2: quando o chamador injeta a leitura da oauth_connection persistida,
  // o status CONNECTED passa a refletir a conexão real (não mais um
  // `connected = false` fixo). Sem banco, permanece NOT_CONNECTED.
  const encryptionReady =
    Boolean(env.DATA_ENCRYPTION_KEY_BASE64?.trim()) &&
    Boolean(env.DOCUMENT_FINGERPRINT_KEY_BASE64?.trim()) &&
    Boolean(env.DATA_ENCRYPTION_KEY_VERSION?.trim());
  const database = await avaliarDatabase(sondarDatabase);
  const oauthConfig = loadGmailOauthConfig(env);
  const oauthStatus = oauthStatusFromEnvironment(env, await (lerConexaoOauth?.() ?? Promise.resolve(false)));
  const realSendEnabled = env.REAL_SEND_ENABLED === "true";
  const pilotMode = env.PILOT_MODE === "true";
  // Seção 5 — REAL_SEND_EXECUTED: derivado do ledger de auditoria existente
  // (PF_COMMUNICATION_ACCEPTED em lote LIVE_PILOT). Nenhum mecanismo novo.
  const realSendExecuted = realSendEnabled && Boolean(await (lerLedgerEnvioReal?.() ?? Promise.resolve(false)));
  // F-GMAIL: modo controlado — transporte real restrito a destinatário
  // controlado configurado fora do Git (defesa independente do GATE 1).
  const controlledMode = env.GMAIL_CONTROLLED_MODE === "true";
  const connected = oauthStatus === "CONNECTED"; // F2: leitura da oauth_connection persistida

  const cryptoItem = encryptionReady
    ? item("Cryptography", "READY", "Chaves de criptografia e fingerprint presentes.")
    : item(
        "Cryptography",
        "BLOCKED_EXTERNAL",
        "Chaves AES/HMAC ausentes no ambiente.",
        "Configurar DATA_ENCRYPTION_KEY_BASE64, DOCUMENT_FINGERPRINT_KEY_BASE64 e DATA_ENCRYPTION_KEY_VERSION.",
      );

  const gmailOauth =
    oauthStatus === "CONFIGURATION_REQUIRED"
      ? item(
          "Gmail OAuth",
          "CONFIGURATION_REQUIRED",
          "Credenciais OAuth ausentes (client id/secret/redirect).",
          "Titular cria credenciais Google OAuth (escopo gmail.send) e configura GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI.",
        )
      : item(
          "Gmail OAuth",
          connected ? "READY" : "BLOCKED_EXTERNAL",
          connected
            ? "Conta conectada (tokens persistidos cifrados)."
            : "Credenciais presentes; conexão da conta ainda não realizada.",
          connected
            ? undefined
            : "Titular conecta a conta institucional no fluxo OAuth (gate humano).",
        );

  const gmailTransport = realSendEnabled
    ? oauthConfig
      ? item("Gmail transport", "READY", "Transporte messages.send habilitado (GATE 1 ativo).")
      : item(
          "Gmail transport",
          "CONFIGURATION_REQUIRED",
          "REAL_SEND_ENABLED=true mas credenciais OAuth ausentes.",
          "Configurar credenciais Google OAuth antes do envio real.",
        )
    : item("Gmail transport", "DISABLED", "Transporte real bloqueado (REAL_SEND_ENABLED=false).");

  const realSend = realSendEnabled
    ? realSendExecuted
      ? item(
          "Real send",
          "EXECUTED",
          "Envio real já registrado no ledger (PF_COMMUNICATION_ACCEPTED em LIVE_PILOT).",
        )
      : item(
          "Real send",
          "BLOCKED_EXTERNAL",
          "GATE 1 ativo; envio real exige GATE 2 (lote ATIVO por decisão humana).",
          "Titular libera o lote (PREPARACAO → ATIVO) para o piloto one-time.",
        )
    : item("Real send", "DISABLED", "Envio real desabilitado por política desta fase.");

  const executionMode: ReadinessReport["executionMode"] = realSendEnabled
    ? "LIVE_PILOT"
    : database.status === "READY" && encryptionReady
      ? "DRY_RUN"
      : "PREFLIGHT";

  return {
    database,
    cryptography: cryptoItem,
    intake: item("Intake", "READY", "Análise/mapping/preflight puros disponíveis."),
    persistence:
      database.status === "READY" && encryptionReady
        ? item("Persistence", "READY", "Repositório operacional transacional disponível.")
        : item(
            "Persistence",
            "BLOCKED_EXTERNAL",
            "Depende de DATABASE_URL e chaves de criptografia.",
            "Configurar banco e chaves de criptografia.",
          ),
    outbox: item(
      "Outbox",
      "READY",
      "Outbox transacional com claim SKIP LOCKED (somente lote ATIVO).",
    ),
    worker: pilotMode
      ? item("Worker", "READY", "Execução controlada one-shot disponível (sem daemon).")
      : item(
          "Worker",
          "DISABLED",
          "PILOT_MODE inativo — processamento da outbox bloqueado.",
          "Definir PILOT_MODE=true para o piloto.",
        ),
    gmailTransport: controlledMode && realSendEnabled
      ? item(
          "Gmail transport",
          "BLOCKED_EXTERNAL",
          "GATE 1 ativo em GMAIL_CONTROLLED_MODE: somente destinatário controlado configurado.",
          "Titular define o destinatário controlado fora do Git antes de qualquer teste real controlado.",
        )
      : gmailTransport,
    gmailOauth,
    realSend,
    ppn: item("PPN", "DISABLED", "Integração PPN/Correios fora do escopo desta fase."),
    executionMode,
  };
}

/**
 * Invariante de execução do worker: recusa processar quando requisitos
 * internos não estão READY (fail-closed).
 */
export function workerPodeExecutar(report: ReadinessReport): { ok: boolean; motivo: string } {
  if (report.database.status !== "READY") {
    return { ok: false, motivo: `DATABASE_${report.database.status}` };
  }
  if (report.cryptography.status !== "READY") {
    return { ok: false, motivo: "CRYPTOGRAPHY_NOT_READY" };
  }
  if (report.worker.status !== "READY") {
    return { ok: false, motivo: "WORKER_DISABLED" };
  }
  return { ok: true, motivo: report.executionMode };
}
