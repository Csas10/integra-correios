import { randomUUID, createHmac } from "node:crypto";
import {
  renderPfPilotConfirmationMail,
  PILOT_SENDER,
  PILOT_SUBJECT,
  PF_PILOT_TEMPLATE_VERSION,
} from "@integra-correios/mail";
import {
  type PostgresOperationalRepository,
  type CommunicationBatchItem,
  type AuditEventInput,
  type CommunicationSource,
  type EncryptedValue,
} from "@integra-correios/persistence";
import { executarWorkerUmaVezLive } from "@integra-correios/worker";
import { providerGmailConfigurado } from "@integra-correios/worker";

/**
 * CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — política do provider para a API:
 * o valor efetivo é lido do AMBIENTE (nunca do request); exposto como
 * SIM/NÃO. Sem Gmail, a rota de execução responde sem mutação (o worker
 * também recusa ANTES do claim) e o diagnóstico marca o transporte como
 * bloqueado.
 */
export interface PoliticaProvider {
  readonly providerGmailConfigurado: boolean;
}

export function carregarPoliticaProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PoliticaProvider {
  return { providerGmailConfigurado: providerGmailConfigurado(env) };
}

/**
 * Piloto PF — seleção com hard cap SERVER-SIDE, preview e criação
 * transacional do lote.
 *
 * HARD CAP: PILOT_MODE=true + PILOT_MAX_RECIPIENTS são lidos do AMBIENTE do
 * processo — o browser não pode alterá-los (nenhum parâmetro da requisição
 * é aceito para o limite).
 *
 * REAL_SEND_ENABLED=false (fail-closed): a preparação do lote cria outbox
 * PENDING, mas o worker NUNCA chama o Gmail real enquanto o flag estiver
 * false no ambiente.
 */

export interface PilotPolicy {
  readonly pilotMode: boolean;
  readonly maxRecipients: number;
  readonly realSendEnabled: boolean;
}

/** Política lida SOMENTE do ambiente (não do request). */
export function carregarPilotPolicy(env: Readonly<Record<string, string | undefined>> = process.env): PilotPolicy {
  const pilotMode = env.PILOT_MODE === "true";
  const raw = env.PILOT_MAX_RECIPIENTS?.trim();
  const max = raw ? Number.parseInt(raw, 10) : 5;
  const maxRecipients = Number.isSafeInteger(max) && max > 0 && max <= 100 ? max : 5;
  return {
    pilotMode,
    maxRecipients,
    realSendEnabled: env.REAL_SEND_ENABLED === "true",
  };
}

// ---------------------------------------------------------------------------
// Cockpit: listagem de profissionais (dados mascarados)
// ---------------------------------------------------------------------------

export interface ProfissionalCockpit {
  readonly id: string;
  readonly codigo: string;
  readonly nome: string;
  readonly emailMascarado: string;
  readonly telefoneMascarado: string;
  readonly enderecoClassificacao: string;
  readonly enderecoResumo: string;
  readonly status: string;
  readonly issues: readonly string[];
  readonly elegivelComunicacao: boolean;
}

export function mascararEmail(email: string): string {
  const arroba = email.indexOf("@");
  if (arroba <= 1) return "***";
  const local = email.slice(0, arroba);
  const dominio = email.slice(arroba);
  return `${local[0]}${"*".repeat(Math.min(local.length - 1, 4))}${dominio}`;
}

export function mascararTelefone(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");
  if (digitos.length < 8) return "***";
  return `***${digitos.slice(-4)}`;
}

export interface LotePilotoRecuperavel {
  readonly loteId: string;
  readonly codigo: string;
  readonly status: "PREPARACAO" | "ATIVO";
  readonly modo: "DRY_RUN";
  readonly totalItens: number;
}

/**
 * Recupera o lote PF/DRY_RUN que ficou em andamento após refresh/reabertura
 * da interface. O PostgreSQL é a autoridade; a UI não pode depender apenas
 * de estado React efêmero para continuar uma operação já persistida.
 */
export async function recuperarLotePilotoEmAndamento(
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
): Promise<LotePilotoRecuperavel | undefined> {
  const result = await pool.query(
    `SELECT l.id, l.codigo, l.status, l.modo,
      count(i.id)::int AS total_itens
    FROM lote_comunicacao l
    JOIN item_lote_comunicacao i ON i.lote_comunicacao_id = l.id
    WHERE l.origem = 'PF'
      AND l.modo = 'DRY_RUN'
      AND l.status IN ('PREPARACAO', 'ATIVO')
    GROUP BY l.id, l.codigo, l.status, l.modo, l.criado_em
    ORDER BY l.criado_em DESC
    LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    loteId: row.id,
    codigo: row.codigo,
    status: row.status,
    modo: "DRY_RUN",
    totalItens: Number(row.total_itens),
  };
}

export class LotePilotoEmAndamentoError extends Error {
  constructor(readonly lote: { loteId: string; codigo: string; status: string }) {
    super(`Já existe lote em andamento para um ou mais profissionais selecionados (${lote.codigo}).`);
    this.name = "LotePilotoEmAndamentoError";
  }
}

async function encontrarLoteConflitante(
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
  professionalIds: readonly string[],
): Promise<{ loteId: string; codigo: string; status: string } | undefined> {
  const result = await pool.query(
    `SELECT DISTINCT l.id, l.codigo, l.status, l.criado_em
    FROM item_lote_comunicacao i
    JOIN lote_comunicacao l ON l.id = i.lote_comunicacao_id
    WHERE i.profissional_id = ANY($1::uuid[])
      AND i.status IN ('RESERVADO', 'ENFILEIRADO', 'PROCESSANDO', 'ENVIADO', 'FALHOU')
    ORDER BY l.criado_em DESC
    LIMIT 1`,
    [professionalIds],
  );
  const row = result.rows[0];
  return row ? { loteId: row.id, codigo: row.codigo, status: row.status } : undefined;
}

/** Cockpit com filtros mínimos da seção 6. */
export type FiltroCockpit =
  | "TODOS"
  | "APTOS_CONTATO"
  | "PENDENCIA_CADASTRAL"
  | "EMAIL_INVALIDO"
  | "ENDERECO_PENDENTE"
  | "SELECIONADOS";

export async function listarProfissionais(
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
  filtro: FiltroCockpit,
  caixa: { open(value: any, context: string): Uint8Array },
): Promise<readonly ProfissionalCockpit[]> {
  let sql = `
    SELECT p.id, p.codigo_operacional, p.status, s.conteudo_ciphertext, s.conteudo_nonce,
      s.conteudo_auth_tag, s.chave_versao
    FROM profissional p
    JOIN snapshot_cadastral s ON s.profissional_id = p.id AND s.tipo = 'ORIGINAL' AND s.vigente`;
  const params: unknown[] = [];
  sql += ` WHERE p.origem = 'PF'`;
  if (filtro === "APTOS_CONTATO") {
    sql += ` AND p.status IN ('CARTEIRA_IDENTIFICADA','APTO_CONTATO','APTO_PREPOSTAGEM')`;
  } else if (filtro === "PENDENCIA_CADASTRAL") {
    sql += ` AND p.status IN ('PENDENCIA_TRIAGEM','PENDENCIA_CADASTRAL')`;
  }
  sql += ` ORDER BY p.codigo_operacional`;

  const result = await pool.query(sql, params);

  const todos: ProfissionalCockpit[] = [];
  for (const row of result.rows) {
    let snapshot: any = {};
    try {
      snapshot = JSON.parse(
        new TextDecoder().decode(
          caixa.open(
            {
              ciphertext: row.conteudo_ciphertext,
              nonce: row.conteudo_nonce,
              authTag: row.conteudo_auth_tag,
              keyVersion: row.chave_versao,
            },
            "snapshot:original",
          ),
        ),
      );
    } catch {
      // Fail-closed de exibição: snapshot ilegível não vaza dado.
    }
    const issues: string[] = [];
    if (!snapshot.email || !snapshot.email.includes("@")) issues.push("E-mail inválido");
    const endereco = snapshot.endereco ?? {};
    const enderecoInformado =
      snapshot.enderecoInformado === true ||
      Boolean(snapshot.enderecoOrigem) ||
      Boolean(endereco.logradouro || endereco.numero || endereco.bairro || endereco.cidade || endereco.uf || endereco.cep);
    if (enderecoInformado && (!endereco.logradouro || !endereco.cidade || !endereco.uf)) {
      issues.push("Endereço pendente");
    }
    todos.push({
      id: row.id,
      codigo: row.codigo_operacional,
      nome: snapshot.nome ?? "",
      emailMascarado: snapshot.email ? mascararEmail(snapshot.email) : "—",
      telefoneMascarado: snapshot.telefone ? mascararTelefone(snapshot.telefone) : "—",
      enderecoClassificacao: !enderecoInformado
        ? "NOT_PROVIDED"
        : issues.includes("Endereço pendente")
          ? "REVIEW_REQUIRED"
          : "PARSED",
      enderecoResumo: endereco.logradouro
        ? `${endereco.logradouro}${endereco.numero ? ", " + endereco.numero : ""} — ${endereco.cidade ?? ""}/${endereco.uf ?? ""}`
        : (snapshot.enderecoOrigem || "Não informado"),
      status: row.status,
      issues,
      elegivelComunicacao: row.status === "APTO_CONTATO" || row.status === "APTO_PREPOSTAGEM",
    });
  }

  if (filtro === "EMAIL_INVALIDO") return todos.filter((p) => p.issues.includes("E-mail inválido"));
  if (filtro === "ENDERECO_PENDENTE") return todos.filter((p) => p.issues.includes("Endereço pendente"));
  return todos;
}

// ---------------------------------------------------------------------------
// Preview da comunicação (NÃO envia)
// ---------------------------------------------------------------------------

export interface PreviewComunicacao {
  readonly professionalId: string;
  readonly codigo: string;
  readonly destinatarioMascarado: string;
  readonly remetente: string;
  readonly assunto: string;
  readonly templateVersion: string;
  readonly corpoTexto: string;
  readonly corpoHtml: string;
}

/**
 * Preview determinístico por profissional. Exige token efêmero apenas para
 * montar URLs — o token REAL é emitido somente na preparação do lote
 * (persistido como hash). O preview NUNCA envia.
 */
export function gerarPreviewComunicacao(
  professionalId: string,
  codigo: string,
  nome: string,
  destinatario: string,
  enderecoApresentado: string,
  telefone: string,
  confirmationBaseUrl: string,
): PreviewComunicacao {
  const confirmUrl = new URL(`/confirma/preview-token-confirmar`, confirmationBaseUrl).toString();
  const updateUrl = new URL(`/confirma/preview-token-atualizar`, confirmationBaseUrl).toString();
  const message = renderPfPilotConfirmationMail({
    confirmationId: `preview-${professionalId}`,
    recipient: destinatario,
    professionalName: nome,
    enderecoApresentado,
    telefone,
    confirmUrl,
    updateUrl,
  });
  return {
    professionalId,
    codigo,
    destinatarioMascarado: mascararEmail(destinatario),
    remetente: `${PILOT_SENDER.name} <${PILOT_SENDER.address}>`,
    assunto: PILOT_SUBJECT,
    templateVersion: message.templateVersion,
    corpoTexto: message.textBody,
    corpoHtml: message.htmlBody,
  };
}

// ---------------------------------------------------------------------------
// Preparação transacional do lote
// ---------------------------------------------------------------------------

export interface PrepararLoteCommand {
  readonly professionalIds: readonly string[];
  readonly operador: string;
  readonly confirmationBaseUrl: string;
  readonly confirmationTtlMs?: number;
  /** Origem dos registros do lote (FINAL CLOSURE GATE item 2). */
  readonly source: CommunicationSource;
}

export interface ResultadoPrepararLote {
  readonly loteId: string;
  readonly codigo: string;
  readonly totalItens: number;
  readonly templateVersion: string;
  readonly realSendEnabled: boolean;
}

/**
 * Valida a seleção contra a política de piloto e cria o lote
 * TRANSCACIONALMENTE (lote + item + confirmacao + comunicacao + outbox +
 * auditoria). Falha antes do COMMIT = ROLLBACK integral (provado na V0).
 *
 * Pré-condições (server-side):
 *  - N >= 1 e N <= maxRecipients (hard cap do ambiente);
 *  - cada profissional APTO_CONTATO/APTO_PREPOSTAGEM;
 *  - nenhum profissional em lote ativo (UNIQUE parcial da migration).
 */
export async function prepararLotePiloto(
  command: PrepararLoteCommand,
  repository: PostgresOperationalRepository,
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
  caixa: { seal(plaintext: string, context: string): EncryptedValue; open(value: EncryptedValue, context: string): Uint8Array },
  fingerprinter: { fingerprint(namespace: string, valor: string): string },
  policy: PilotPolicy,
  tokens: { issue(): Promise<{ plainToken: string; tokenHash: string }>; hash(plain: string): Promise<string> },
): Promise<ResultadoPrepararLote> {
  if (!policy.pilotMode) {
    throw new Error("PILOT_MODE inativo — preparação de lote bloqueada.");
  }
  const n = command.professionalIds.length;
  if (n < 1) throw new Error("Seleção vazia.");
  if (n > policy.maxRecipients) {
    throw new Error(
      `Seleção de ${n} excede o limite do piloto (${policy.maxRecipients}) — bloqueado no backend.`,
    );
  }
  const idsUnicos = new Set(command.professionalIds);
  if (idsUnicos.size !== n) throw new Error("Profissional duplicado na seleção.");

  // Snapshot dos profissionais + e-mail para o envio (persistido cifrado).
  const snapshots = await pool.query(
    `SELECT p.id, p.codigo_operacional, p.status, s.conteudo_ciphertext, s.conteudo_nonce,
      s.conteudo_auth_tag, s.chave_versao
    FROM profissional p
    JOIN snapshot_cadastral s ON s.profissional_id = p.id AND s.tipo = 'ORIGINAL' AND s.vigente
    WHERE p.id = ANY($1::uuid[]) AND p.origem = 'PF'`,
    [[...idsUnicos]],
  );
  if (snapshots.rows.length !== n) {
    throw new Error("Profissional inexistente na seleção.");
  }
  for (const row of snapshots.rows) {
    if (row.status !== "APTO_CONTATO" && row.status !== "APTO_PREPOSTAGEM") {
      throw new Error(
        `Profissional ${row.codigo_operacional} em status ${row.status} — somente APTO_CONTATO/APTO_PREPOSTAGEM entram em lote.`,
      );
    }
  }

  const loteExistente = await encontrarLoteConflitante(pool, [...idsUnicos]);
  if (loteExistente) {
    throw new LotePilotoEmAndamentoError(loteExistente);
  }

  const loteId = randomUUID();
  const codigo = `PF-MAIL-PILOTO-${Date.now().toString(36).toUpperCase()}`;
  const agora = new Date().toISOString();
  const expiraEm = new Date(Date.now() + (command.confirmationTtlMs ?? 7 * 24 * 3_600_000)).toISOString();

  const items: CommunicationBatchItem[] = [];
  for (const row of snapshots.rows) {
    const snapshot = JSON.parse(
      new TextDecoder().decode(
        caixa.open(
          {
            ciphertext: row.conteudo_ciphertext,
            nonce: row.conteudo_nonce,
            authTag: row.conteudo_auth_tag,
            keyVersion: row.chave_versao,
          },
          "snapshot:original",
        ),
      ),
    );
    const token = await tokens.issue();
    const confirmationId = randomUUID();
    const communicationId = randomUUID();
    const outboxId = randomUUID();

    // Payload cifrado do outbox: o que o worker enviará (sem PII em claro).
    const payload = {
      professionalId: row.id,
      codigo: row.codigo_operacional,
      nome: snapshot.nome ?? "",
      destinatario: snapshot.email ?? "",
      enderecoApresentado: snapshot.enderecoOrigem ?? "",
      telefone: snapshot.telefone ?? "",
      whatsapp: snapshot.whatsapp,
      plainToken: token.plainToken,
      confirmationId,
      communicationId,
      confirmationBaseUrl: command.confirmationBaseUrl,
    };

    items.push({
      professionalId: row.id,
      confirmationId,
      communicationId,
      outboxId,
      tokenHash: token.tokenHash,
      expiresAt: expiraEm,
      recipientFingerprint: fingerprinter.fingerprint("email-piloto", snapshot.email ?? row.id),
      idempotencyKey: `pf-pilot:${confirmationId}:${PF_PILOT_TEMPLATE_VERSION}`,
      encryptedPayload: caixa.seal(JSON.stringify(payload), "outbox:email"),
      auditEvent: {
        id: randomUUID(),
        aggregateType: "PROFISSIONAL",
        aggregateId: row.id,
        type: "PF_CONFIRMACAO_EMITIDA",
        actorId: command.operador,
        occurredAt: agora,
        metadata: { loteComunicacaoId: loteId, templateVersion: PF_PILOT_TEMPLATE_VERSION },
        eventHash: hashEvento(confirmationId, agora),
      } satisfies AuditEventInput,
    });
  }

  await repository.enqueueCommunicationBatch({
    id: loteId,
    code: codigo,
    origin: "PF",
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
    mode: "DRY_RUN",
    source: command.source,
    createdBy: command.operador,
    createdAt: agora,
    auditEvent: {
      id: randomUUID(),
      aggregateType: "LOTE_COMUNICACAO",
      aggregateId: loteId,
      type: "PF_LOTE_COMUNICACAO_CRIADO",
      actorId: command.operador,
      occurredAt: agora,
      metadata: { totalItens: items.length, modo: "PILOTO" },
      eventHash: hashEvento(loteId, agora),
    },
    items,
  });

  return {
    loteId,
    codigo,
    totalItens: items.length,
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
    realSendEnabled: policy.realSendEnabled,
  };
}

function hashEvento(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}

/** Status da outbox para a UI (sem payload). */
export async function statusOutbox(
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
  loteId?: string,
): Promise<
  readonly {
    outboxId: string;
    codigo: string | null;
    status: string;
    tentativas: number;
    erroCodigo: string | null;
  }[]
> {
  const result = await pool.query(
    `SELECT o.id AS outbox_id, l.codigo, o.status, o.tentativas, o.ultimo_erro_codigo AS erro
    FROM outbox_email o
    JOIN comunicacao c ON c.id = o.comunicacao_id
    LEFT JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
    ${loteId ? "WHERE c.lote_comunicacao_id = $1" : ""}
    ORDER BY o.criada_em DESC
    LIMIT 100`,
    loteId ? [loteId] : [],
  );
  return result.rows.map((row) => ({
    outboxId: row.outbox_id,
    codigo: row.codigo,
    status: row.status,
    tentativas: row.tentativas,
    erroCodigo: row.erro,
  }));
}

/** Status da outbox para a UI (sem payload). */

// ---------------------------------------------------------------------------
// TESTE CONTROLADO GMAIL — lote sintético de EXATAMENTE uma comunicação para
// o destinatário controlado (GATE 2). Nenhum dado institucional:
//   - registro profissional totalmente sintético (sem CPF/telefone/endereço);
//   - fonte persistida CONTROLADO_SINTETICO (nunca INSTITUCIONAL_XLSX);
//   - destinatário copiado EXATAMENTE de GMAIL_CONTROLLED_RECIPIENT;
//   - template homologado pf-pilot-crtba-v1 (PF_PILOT_TEMPLATE_VERSION);
//   - lote nasce PREPARACAO (ativação é ação humana separada e auditada);
//   - modo LIVE_PILOT: único caminho que o motor LIVE aceita (F7) — e enquanto
//     REAL_SEND_ENABLED=false o GATE 1 mantém tudo bloqueado (zero chamadas).
// A preparação é IDEMPOTENTE pelo código canônico do lote (UNIQUE origem+codigo).
// ---------------------------------------------------------------------------

export const CODIGO_LOTE_TESTE_CONTROLADO = "CONTROLLED_GMAIL_TEST";

/**
 * Código canônico do lote DRY_RUN histórico validado diretamente no Neon:
 * registros sintéticos SINT-PF-001..003, fonte PF_DRY_RUN_SINTETICO_HARD_GATE_B,
 * outbox SENT=3 em DRY_RUN, confirmações PENDING=3, zero chamadas Gmail.
 * O cancelamento auditado aceita SOMENTE este código.
 */
export const CODIGO_LOTE_HISTORICO_DRY_RUN = "PF-MAIL-PILOTO-MUB37G1H";

export interface ValidaçãoCancelamento {
  readonly codigo: string;
  readonly status: string;
  readonly modo: string;
  readonly totalItens: number;
}

/**
 * Pré-voo do cancelamento do lote histórico (server-side, fail-closed):
 * o cancelamento só vale para o lote EXATO, ATIVO e DRY_RUN. Qualquer outro
 * lote — inclusive LIVE_PILOT/CONTROLLED_GMAIL_TEST — é rejeitado aqui.
 */
export function validarCancelamentoLoteHistorico(
  lote: {
    codigo?: string | null;
    status?: string | null;
    modo?: string | null;
  } | null | undefined,
): void {
  if (!lote || !lote.codigo) {
    throw new Error("NOT_HISTORICAL_BATCH: lote inexistente");
  }
  if (lote.codigo !== CODIGO_LOTE_HISTORICO_DRY_RUN) {
    throw new Error(
      `NOT_HISTORICAL_BATCH: somente o lote histórico ${CODIGO_LOTE_HISTORICO_DRY_RUN} pode ser cancelado`,
    );
  }
  if (lote.modo !== "DRY_RUN") {
    throw new Error(`MODE_NOT_DRY_RUN: lote em modo ${lote.modo ?? "desconhecido"}`);
  }
  if (lote.status !== "ATIVO" && lote.status !== "CANCELADO") {
    throw new Error(`INVALID_STATE: lote em status ${lote.status ?? "desconhecido"}`);
  }
}
const CODIGO_PROFISSIONAL_SINTETICO = "SINTETICO-CONTROLADO-GMAIL";
const MARCADOR_DOCUMENTO_SINTETICO = "REGISTRO-SINTETICO-SEM-DOCUMENTO";
const NOME_SINTETICO = "Pessoa Sintetica (Teste Controlado)";

export interface PoliticaControlada {
  readonly controlledMode: boolean;
  readonly controlledRecipient: string;
  readonly realSendEnabled: boolean;
}

/** Política do teste controlado lida SOMENTE do ambiente (não do request). */
export function carregarPoliticaControlada(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PoliticaControlada {
  return {
    controlledMode: env.GMAIL_CONTROLLED_MODE === "true",
    controlledRecipient: (env.GMAIL_CONTROLLED_RECIPIENT ?? "").trim(),
    realSendEnabled: env.REAL_SEND_ENABLED === "true",
  };
}

/** OUTBOX_GATE_CHAIN_FIX — estado sanitizado da outbox do teste controlado. */
export interface EstadoOutboxControlado {
  readonly status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "FAILED_PERMANENT" | "CANCELLED";
  readonly tentativas: number;
  readonly codigoErro: string | null;
}

export interface EstadoLoteControladoItem {
  readonly loteId: string;
  readonly status: "PREPARACAO" | "ATIVO" | "CONCLUIDO" | "CANCELADO";
  readonly modo: "DRY_RUN" | "LIVE_PILOT";
  readonly totalItens: number;
  readonly fonteRegistro: CommunicationSource | null;
  readonly receiptAnterior: boolean;
  readonly liberacaoHumanaAuditada: boolean;
  /** PRE_CLAIM_500_DIAGNOSIS — evento PF_CONTROLLED_RETRY_AUTORIZADO posterior
   * à última mutação FAILED da outbox do teste (correlação via bloqueada_em).
   * null = não aplicável (outbox não está FAILED) ou lote inexistente. */
  readonly retryAuditadoVigente: boolean | null;
  /** OUTBOX_GATE_CHAIN_FIX — estado atual da outbox do teste, sanitizado
   * (status/tentativas/código de erro); null = outbox inexistente. */
  readonly outbox?: EstadoOutboxControlado | null;
  /** Verificação server-side do payload: destinatário === controlado.
   * null = indeterminado (payload ilegível/ausente) — exibição fail-closed. */
  readonly destinatarioCorresponde: boolean | null;
}

export interface EstadoLoteControlado {
  readonly codigo: string;
  readonly outboxPendenteForaDoTeste: number;
  readonly outboxProcessamento: number;
  readonly lotesAtivosForaDoTeste: number;
  readonly lote: EstadoLoteControladoItem | null;
}

type PoolConsulta = {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
};

/**
 * Consulta READ-ONLY do estado do teste controlado (pré-voo de ativação/envio).
 * Contagens fora do teste excluem o lote CONTROLLED_GMAIL_TEST por código;
 * receipt anterior e liberação humana auditada são DERIVADOS do banco.
 */
export async function lerEstadoLoteControlado(
  pool: PoolConsulta,
  opcoes: {
    caixa?: { open(value: EncryptedValue, context: string): Uint8Array };
    controlledRecipient?: string;
  } = {},
): Promise<EstadoLoteControlado> {
  const codigo = CODIGO_LOTE_TESTE_CONTROLADO;
  const contagens = await pool.query(
    `SELECT
      (SELECT count(*) FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE o.status IN ('PENDING', 'FAILED') AND l.codigo <> $1) AS pendente_fora,
      (SELECT count(*) FROM outbox_email o WHERE o.status = 'PROCESSING') AS processamento,
      (SELECT count(*) FROM lote_comunicacao l WHERE l.status = 'ATIVO' AND l.codigo <> $1) AS ativos_fora`,
    [codigo],
  );
  const linhas = await pool.query(
    `SELECT l.id AS lote_id, l.status AS lote_status, l.modo AS lote_modo,
      (SELECT count(*) FROM item_lote_comunicacao i WHERE i.lote_comunicacao_id = l.id) AS total_itens,
      (SELECT c.fonte_registro FROM comunicacao c WHERE c.lote_comunicacao_id = l.id LIMIT 1) AS fonte_registro,
      (SELECT count(*) FROM comunicacao c WHERE c.lote_comunicacao_id = l.id AND c.provider = 'GMAIL') AS receipts,
      (SELECT count(*) FROM evento_auditoria ea
        WHERE ea.agregado_tipo = 'LOTE_COMUNICACAO' AND ea.agregado_id = l.id
          AND ea.tipo = 'PF_LOTE_COMUNICACAO_ATIVADO') AS ativacoes,
      (SELECT ob1.status FROM outbox_email ob1
        JOIN comunicacao c1 ON c1.id = ob1.comunicacao_id
        WHERE c1.lote_comunicacao_id = l.id
        ORDER BY COALESCE(ob1.bloqueada_em, ob1.criada_em) DESC LIMIT 1) AS outbox_status,
      (SELECT ob1.tentativas FROM outbox_email ob1
        JOIN comunicacao c1 ON c1.id = ob1.comunicacao_id
        WHERE c1.lote_comunicacao_id = l.id
        ORDER BY COALESCE(ob1.bloqueada_em, ob1.criada_em) DESC LIMIT 1) AS outbox_tentativas,
      (SELECT ob1.ultimo_erro_codigo FROM outbox_email ob1
        JOIN comunicacao c1 ON c1.id = ob1.comunicacao_id
        WHERE c1.lote_comunicacao_id = l.id
        ORDER BY COALESCE(ob1.bloqueada_em, ob1.criada_em) DESC LIMIT 1) AS outbox_erro,
      (SELECT count(*) FROM evento_auditoria ea
        WHERE ea.agregado_tipo = 'LOTE_COMUNICACAO' AND ea.agregado_id = l.id
          AND ea.tipo = 'PF_CONTROLLED_RETRY_AUTORIZADO'
          AND ea.ocorreu_em > COALESCE((
            SELECT max(ob2.bloqueada_em) FROM outbox_email ob2
            JOIN comunicacao c2 ON c2.id = ob2.comunicacao_id
            WHERE c2.lote_comunicacao_id = l.id AND ob2.status = 'FAILED'), 'epoch')) AS retry_vigente,
      ob.payload_ciphertext, ob.payload_nonce, ob.payload_auth_tag, ob.chave_versao
    FROM lote_comunicacao l
    LEFT JOIN LATERAL (
      SELECT o.payload_ciphertext, o.payload_nonce, o.payload_auth_tag, o.chave_versao
      FROM outbox_email o
      JOIN comunicacao c ON c.id = o.comunicacao_id
      WHERE c.lote_comunicacao_id = l.id
      LIMIT 1
    ) ob ON true
    WHERE l.origem = 'PF' AND l.codigo = $1`,
    [codigo],
  );

  const contagem = contagens.rows[0];
  const linha = linhas.rows[0];
  let lote: EstadoLoteControladoItem | null = null;
  if (linha) {
    let destinatarioCorresponde: boolean | null = null;
    if (
      opcoes.caixa &&
      opcoes.controlledRecipient &&
      linha.payload_ciphertext &&
      linha.payload_nonce &&
      linha.payload_auth_tag &&
      linha.chave_versao
    ) {
      try {
        const payload = JSON.parse(
          new TextDecoder().decode(
            opcoes.caixa.open(
              {
                ciphertext: Buffer.from(linha.payload_ciphertext),
                nonce: Buffer.from(linha.payload_nonce),
                authTag: Buffer.from(linha.payload_auth_tag),
                keyVersion: linha.chave_versao,
              },
              "outbox:email",
            ),
          ),
        ) as { destinatario?: string };
        destinatarioCorresponde =
          (payload.destinatario ?? "").trim().toLowerCase() ===
          opcoes.controlledRecipient.trim().toLowerCase();
      } catch {
        destinatarioCorresponde = null;
      }
    }
    lote = {
      loteId: linha.lote_id,
      status: linha.lote_status as EstadoLoteControladoItem["status"],
      modo: linha.lote_modo as EstadoLoteControladoItem["modo"],
      totalItens: Number(linha.total_itens),
      fonteRegistro: (linha.fonte_registro as CommunicationSource | null) ?? null,
      receiptAnterior: Number(linha.receipts) > 0,
      liberacaoHumanaAuditada: Number(linha.ativacoes) > 0,
      // PRE_CLAIM_500_DIAGNOSIS — visível no painel: a autorização de retry
      // auditada está vigente (posterior à última mutação FAILED) ou não.
      retryAuditadoVigente: Number(linha.receipts) === 0 && Number(linha.retry_vigente ?? 0) > 0,
      // OUTBOX_GATE_CHAIN_FIX — estado atual da outbox, para a UI bloquear
      // execução quando a falha não é pré-rede (FAILED_PERMANENT). Última
      // mutação pela coluna real bloqueada_em (markOutboxFailed/claim).
      outbox: linha.outbox_status
        ? {
            status: String(linha.outbox_status) as EstadoOutboxControlado["status"],
            tentativas: Number(linha.outbox_tentativas ?? 0),
            codigoErro: (linha.outbox_erro as string | null) ?? null,
          }
        : null,
      destinatarioCorresponde,
    };
  }
  return {
    codigo,
    outboxPendenteForaDoTeste: Number(contagem?.pendente_fora ?? 0),
    outboxProcessamento: Number(contagem?.processamento ?? 0),
    lotesAtivosForaDoTeste: Number(contagem?.ativos_fora ?? 0),
    lote,
  };
}

export class BloqueioLoteControladoError extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "BloqueioLoteControladoError";
  }
}

export interface PrepararLoteControladoCommand {
  readonly operador: string;
  readonly confirmationBaseUrl: string;
  readonly confirmationTtlMs?: number;
  /** OAuth Gmail READY (configuração + conexão persistida) — exigido pelo
   * pré-voo desta etapa; o envio em si permanece bloqueado por GATE 1/2. */
  readonly oauthPronto: boolean;
}

export interface ResultadoLoteControlado {
  readonly criado: boolean;
  readonly loteId: string | null;
  readonly codigo: string;
  readonly totalItens: number;
  readonly estado: EstadoLoteControlado;
}

/**
 * Cria (idempotentemente) o lote CONTROLLED_GMAIL_TEST: exatamente UMA
 * comunicação sintética para o destinatário controlado. Fail-closed: cada
 * exigência do pré-voo é validada server-side ANTES de qualquer INSERT.
 */
export async function prepararLoteTesteControlado(
  command: PrepararLoteControladoCommand,
  repository: Pick<PostgresOperationalRepository, "enqueueCommunicationBatch">,
  pool: PoolConsulta,
  caixa: { seal(plaintext: string, context: string): EncryptedValue; open(value: EncryptedValue, context: string): Uint8Array },
  fingerprinter: { fingerprint(namespace: string, valor: string): string },
  tokens: { issue(): Promise<{ plainToken: string; tokenHash: string }>; hash(plain: string): Promise<string> },
  politica: PoliticaControlada,
  agora: Date = new Date(),
): Promise<ResultadoLoteControlado> {
  if (!politica.controlledMode) {
    throw new BloqueioLoteControladoError(
      "CONTROLLED_MODE_REQUIRED",
      "GMAIL_CONTROLLED_MODE deve estar ativo para preparar o teste controlado.",
    );
  }
  if (!politica.controlledRecipient) {
    throw new BloqueioLoteControladoError(
      "CONTROLLED_RECIPIENT_REQUIRED",
      "GMAIL_CONTROLLED_RECIPIENT não configurado — destinatário controlado ausente.",
    );
  }
  if (!politica.controlledRecipient.includes("@")) {
    throw new BloqueioLoteControladoError(
      "CONTROLLED_RECIPIENT_INVALID",
      "Destinatário controlado configurado não é um endereço de e-mail válido.",
    );
  }
  if (politica.realSendEnabled) {
    throw new BloqueioLoteControladoError(
      "REAL_SEND_ARMED",
      "REAL_SEND_ENABLED=true — esta etapa exige false. Desarme o envio real antes de preparar o lote.",
    );
  }
  if (!command.oauthPronto) {
    throw new BloqueioLoteControladoError(
      "OAUTH_NOT_READY",
      "OAuth Gmail não está READY (configuração ou conexão ausente).",
    );
  }

  const estado = await lerEstadoLoteControlado(pool, {
    caixa,
    controlledRecipient: politica.controlledRecipient,
  });
  if (estado.outboxPendenteForaDoTeste > 0) {
    throw new BloqueioLoteControladoError(
      "OUTBOX_PENDING_OUTSIDE_TEST",
      `Outbox pendente fora do teste: ${estado.outboxPendenteForaDoTeste}. Zere a fila antes do teste controlado.`,
    );
  }
  if (estado.outboxProcessamento > 0) {
    throw new BloqueioLoteControladoError(
      "OUTBOX_PROCESSING",
      `Outbox em processamento: ${estado.outboxProcessamento}. Aguarde a conclusão antes do teste controlado.`,
    );
  }
  if (estado.lotesAtivosForaDoTeste > 0) {
    throw new BloqueioLoteControladoError(
      "ACTIVE_BATCHES_OUTSIDE_TEST",
      `Lotes ATIVOS fora do teste: ${estado.lotesAtivosForaDoTeste}. Conclua ou cancele antes do teste controlado.`,
    );
  }
  // Idempotência canônica: lote com o código já existe → nada é criado.
  if (estado.lote) {
    return {
      criado: false,
      loteId: estado.lote.loteId,
      codigo: estado.codigo,
      totalItens: estado.lote.totalItens,
      estado,
    };
  }

  const professionalId = await garantirProfissionalSintetico(
    pool,
    caixa,
    fingerprinter,
    command.operador,
    agora.toISOString(),
  );

  const loteId = randomUUID();
  const confirmationId = randomUUID();
  const communicationId = randomUUID();
  const outboxId = randomUUID();
  const token = await tokens.issue();
  const expiraEm = new Date(agora.getTime() + (command.confirmationTtlMs ?? 7 * 24 * 3_600_000)).toISOString();
  const createdAt = agora.toISOString();

  // Payload do outbox: destinatário EXATAMENTE o controlado configurado;
  // nenhum CPF, telefone ou endereço real (registro 100% sintético).
  const payload = {
    professionalId,
    codigo: CODIGO_PROFISSIONAL_SINTETICO,
    nome: NOME_SINTETICO,
    destinatario: politica.controlledRecipient,
    enderecoApresentado: "Registro sintético do teste controlado — sem endereço",
    telefone: "",
    plainToken: token.plainToken,
    confirmationId,
    communicationId,
    confirmationBaseUrl: command.confirmationBaseUrl,
  };

  const item: CommunicationBatchItem = {
    professionalId,
    confirmationId,
    communicationId,
    outboxId,
    tokenHash: token.tokenHash,
    expiresAt: expiraEm,
    recipientFingerprint: fingerprinter.fingerprint("email-piloto", politica.controlledRecipient),
    idempotencyKey: `pf-pilot:${confirmationId}:${PF_PILOT_TEMPLATE_VERSION}`,
    encryptedPayload: caixa.seal(JSON.stringify(payload), "outbox:email"),
    auditEvent: {
      id: randomUUID(),
      aggregateType: "PROFISSIONAL",
      aggregateId: professionalId,
      type: "PF_CONFIRMACAO_EMITIDA",
      actorId: command.operador,
      occurredAt: createdAt,
      metadata: { loteComunicacaoId: loteId, templateVersion: PF_PILOT_TEMPLATE_VERSION },
      eventHash: hashEvento(confirmationId, createdAt),
    },
  };

  await repository.enqueueCommunicationBatch({
    id: loteId,
    code: CODIGO_LOTE_TESTE_CONTROLADO,
    origin: "PF",
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
    // Modo LIVE_PILOT: único modo que o motor LIVE aceita (F7). Nada é enviado
    // nesta etapa: lote nasce PREPARACAO e REAL_SEND_ENABLED=false mantém o
    // GATE 1 fechado (zero chamadas Gmail).
    mode: "LIVE_PILOT",
    source: "CONTROLADO_SINTETICO",
    createdBy: command.operador,
    createdAt,
    auditEvent: {
      id: randomUUID(),
      aggregateType: "LOTE_COMUNICACAO",
      aggregateId: loteId,
      type: "PF_LOTE_COMUNICACAO_CRIADO",
      actorId: command.operador,
      occurredAt: createdAt,
      metadata: { totalItens: 1, modo: "LIVE_PILOT", finalidade: "teste-controlado-gmail" },
      eventHash: hashEvento(loteId, createdAt),
    },
    items: [item],
  });

  return {
    criado: true,
    loteId,
    codigo: CODIGO_LOTE_TESTE_CONTROLADO,
    totalItens: 1,
    estado,
  };
}

// ---------------------------------------------------------------------------
// ATIVAÇÃO + EXECUÇÃO LIVE CONTROLADA (uma única mensagem).
//
// Ativação: reutiliza o mecanismo auditado existente (CAS PREPARACAO → ATIVO
// + PF_LOTE_COMUNICACAO_ATIVADO). Restrita ao lote CONTROLLED_GMAIL_TEST.
//
// Execução: run-once LIVE com pré-voo fail-closed — exatamente 1 comunicação,
// zero receipts Gmail globais, nenhum outro lote ATIVO e nenhuma pendência fora
// do teste. Nenhum loop e nenhum retry automático (DELIVERY_UNKNOWN/
// AUTH_REQUIRED/FAILED_PERMANENT interrompem; o motor existente já impede
// retry desses códigos).
// ---------------------------------------------------------------------------

export class BloqueioExecucaoControladaError extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "BloqueioExecucaoControladaError";
  }
}

/**
 * PRE_CLAIM_500_DIAGNOSIS — falhas esperadas do caminho da execução controlada
 * NUNCA respondem o 500 opaco "Falha na execução controlada.": bloqueio de
 * domínio → 409 + codigo; infraestrutura (banco/provider) → 503 + codigo.
 * O motivo estrutural de log é um código curto determinístico — nunca a
 * mensagem bruta do erro (pode conter DSN, token ou PII).
 */
export function mapearFalhaExecucao(error: unknown): {
  status: 409 | 503;
  codigo: string;
  motivo: string;
  classeErro: string;
} {
  if (error instanceof BloqueioExecucaoControladaError) {
    return {
      status: 409,
      codigo: error.codigo,
      motivo: error.codigo,
      classeErro: "BloqueioExecucaoControladaError",
    };
  }
  const classeErro = error instanceof Error ? error.name : "Unknown";
  return {
    status: 503,
    codigo: "EXECUTION_UNAVAILABLE",
    motivo: `EXECUTION_UNAVAILABLE:${classeErro.slice(0, 60)}`,
    classeErro,
  };
}

/** Log estruturado sanitizado do catch externo (sem mensagem bruta/PII). */
export function registrarFalhaExecucao(
  fase: string,
  mapeado: ReturnType<typeof mapearFalhaExecucao>,
  contexto: { requestId: string; runId?: string } = { requestId: "desconhecido" },
): void {
  console.error(
    JSON.stringify({
      fase,
      requestId: contexto.requestId,
      ...(contexto.runId ? { runId: contexto.runId } : {}),
      classeErro: mapeado.classeErro,
      motivo: mapeado.motivo,
      status: mapeado.status,
      codigo: mapeado.codigo,
    }),
  );
}

/**
 * Ativa (CAS PREPARACAO → ATIVO) exclusivamente o lote CONTROLLED_GMAIL_TEST,
 * com pré-voo idêntico ao da preparação (outbox/lotes fora do teste zerados).
 * A confirmação humana textual é validada pelo chamador (rota da API).
 */
export async function ativarLoteControlado(
  command: { loteId: string; operador: string },
  repository: Pick<PostgresOperationalRepository, "ativarLoteComunicacao">,
  pool: PoolConsulta,
  politica: PoliticaControlada,
): Promise<{ resultCode: string; status: string; loteId: string }> {
  if (!politica.controlledMode) {
    throw new BloqueioLoteControladoError(
      "CONTROLLED_MODE_REQUIRED",
      "GMAIL_CONTROLLED_MODE deve estar ativo para ativar o lote controlado.",
    );
  }
  if (!politica.controlledRecipient) {
    throw new BloqueioLoteControladoError(
      "CONTROLLED_RECIPIENT_REQUIRED",
      "GMAIL_CONTROLLED_RECIPIENT não configurado — destinatário controlado ausente.",
    );
  }
  if (politica.realSendEnabled === false) {
    // Ativação SEM armamento é permitida (gate humano antecipado), mas a
    // execução LIVE continua impossível enquanto REAL_SEND_ENABLED=false.
  }
  const estado = await lerEstadoLoteControlado(pool);
  if (estado.outboxPendenteForaDoTeste > 0) {
    throw new BloqueioLoteControladoError(
      "OUTBOX_PENDING_OUTSIDE_TEST",
      `Outbox pendente fora do teste: ${estado.outboxPendenteForaDoTeste}.`,
    );
  }
  if (estado.outboxProcessamento > 0) {
    throw new BloqueioLoteControladoError(
      "OUTBOX_PROCESSING",
      `Outbox em processamento: ${estado.outboxProcessamento}.`,
    );
  }
  if (estado.lotesAtivosForaDoTeste > 0) {
    throw new BloqueioLoteControladoError(
      "ACTIVE_BATCHES_OUTSIDE_TEST",
      `Lotes ATIVOS fora do teste: ${estado.lotesAtivosForaDoTeste}.`,
    );
  }
  if (!estado.lote || estado.lote.loteId !== command.loteId) {
    throw new BloqueioLoteControladoError(
      "LOTE_CONTROLADO_INEXISTENTE",
      "Lote controlado inexistente ou loteId divergente do canônico.",
    );
  }
  if (estado.lote.status === "ATIVO") {
    return { resultCode: "ALREADY_ACTIVE", status: "ATIVO", loteId: command.loteId };
  }
  if (estado.lote.status !== "PREPARACAO") {
    throw new BloqueioLoteControladoError(
      "INVALID_STATE",
      `Lote controlado em status ${estado.lote.status} não pode ser ativado.`,
    );
  }
  const agora = new Date().toISOString();
  const resultado = await repository.ativarLoteComunicacao({
    batchId: command.loteId,
    origin: "PF",
    actorId: command.operador,
    activatedAt: agora,
    auditEvent: {
      id: randomUUID(),
      aggregateType: "LOTE_COMUNICACAO",
      aggregateId: command.loteId,
      type: "PF_LOTE_COMUNICACAO_ATIVADO",
      actorId: command.operador,
      occurredAt: agora,
      metadata: { totalItens: estado.lote.totalItens, finalidade: "envio-controlado-unico" },
      eventHash: hashEvento(command.loteId, agora),
    },
  });
  return { resultCode: resultado.resultCode, status: resultado.status, loteId: command.loteId };
}

export interface ResultadoExecucaoControlada {
  readonly executionMode: "CONTROLLED_GMAIL_TEST";
  readonly communicationId: string;
  readonly estadoComunicacao: string;
  readonly sentItems: number;
  readonly falhas: number;
  /** True somente quando a iteração run-once realmente processou itens. */
  readonly executado: boolean;
  /** Motivo de bloqueio propagado pelo motor (nunca “sucesso sem envio”). */
  readonly motivoBloqueio: string | null;
  /** Estado da outbox após a iteração (SENT/FAILED/…). */
  readonly statusOutbox: string;
  readonly tentativas: number;
  readonly erroCodigo: string | null;
  /** Provider message/thread id presentes (SIM/NÃO — nunca o valor). */
  readonly messageIdPresente: boolean;
  readonly threadIdPresente: boolean;
}

export type ExecucaoLiveControlada = typeof executarWorkerUmaVezLive;

/** Falha pré-rede comprovada que habilita o retry controlado exclusivo. */
export const CODIGO_RETRY_PRE_REDE = "PROVIDER_NOT_CONFIGURED";

/** OUTBOX_GATE_CHAIN_FIX — código do incidente de gate pré-messages.send. */
export const CODIGO_GATE_OAUTH_NOT_READY = "CONTROLLED_GATE_OAUTH_NOT_READY";

/**
 * OUTBOX_GATE_CHAIN_FIX — códigos que representam o MESMO incidente de gate
 * pré-messages.send: a linha legada foi gravada como FAILED_PERMANENT antes
 * da classificação específica existir; a nova grava CONTROLLED_GATE_OAUTH_NOT_READY.
 */
export const CODIGOS_INCIDENTE_GATE = [CODIGO_GATE_OAUTH_NOT_READY, "FAILED_PERMANENT"] as const;

/**
 * CORRECTIVE_LEGACY_INCIDENT_BINDING — comunicação EXATA do incidente legado,
 * definida server-side (NUNCA recebida do navegador). O vínculo obrigatório
 * aplica-se SOMENTE à classificação legada FAILED_PERMANENT: o código genérico
 * também representa outras falhas permanentes (ex.: divergência de
 * destinatário), então sem o vínculo qualquer FAILED_PERMANENT do lote
 * controlado seria tratado como o incidente OAuth.
 */
export const COMUNICACAO_INCIDENTE_LEGADO = "b76a1e9b-a59d-4777-8777-c2e61536613c";

/**
 * OUTBOX_GATE_CHAIN_FIX — RECUPERAÇÃO AUDITADA EXCLUSIVA do incidente
 * CONTROLLED_GATE_OAUTH_NOT_READY: bloqueio de gate comprovadamente PRÉ-
 * messages.send (zero chamada Gmail, refresh sem envio, OAuth persistido
 * ativo). Toda a validação fail-closed e a mutação PENDING + evento de
 * auditoria acontecem em UMA transação no repositório
 * (recuperarOutboxControlada) — sem reutilizar o retry anterior e sem
 * apagar histórico. Idempotente: já recuperado → estado atual.
 */
export async function autorizarRecuperacaoOauthGate(
  repository: Pick<PostgresOperationalRepository, "recuperarOutboxControlada">,
  operador: string,
  realSendEnabled: boolean,
): Promise<{ autorizado: boolean; resultCode: string; outboxId: string; status: string }> {
  const agora = new Date().toISOString();
  // CORRECTIVE_LEGACY_INCIDENT_BINDING — operador sanitizado (sem e-mail/PII)
  // para o metadata do evento de auditoria.
  const operadorSanitizado = /^[A-Za-z0-9_.:-]{1,80}$/.test(operador.trim())
    ? operador.trim()
    : "operador-nao-identificado";
  for (const codigo of CODIGOS_INCIDENTE_GATE) {
    // Vínculo à comunicação EXATA somente na classificação LEGADA: o código
    // genérico FAILED_PERMANENT também cobre outras falhas permanentes.
    const legado = codigo === "FAILED_PERMANENT";
    try {
      const resultado = await repository.recuperarOutboxControlada({
        expectedCode: CODIGO_LOTE_TESTE_CONTROLADO,
        expectedErrorCode: codigo,
        expectedAttempts: 2,
        ...(legado ? { expectedCommunicationId: COMUNICACAO_INCIDENTE_LEGADO } : {}),
        realSendEnabled,
        availableAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: "",
          type: "PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO",
          occurredAt: agora,
          actorId: operadorSanitizado,
          metadata: {
            motivo: codigo,
            finalidade: "recuperacao-gate-pre-send",
            operador: operadorSanitizado,
          },
          eventHash: hashEvento(CODIGO_LOTE_TESTE_CONTROLADO, agora),
        },
      });
      return { autorizado: true, ...resultado };
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const classe = mensagem.split(":")[0] ?? "RECOVERY_FAILED";
      // ERROR_CODE_MISMATCH com um código do MESMO incidente → tenta o próximo
      // (a linha LEGADA foi gravada antes da classificação específica existir).
      if (classe === "ERROR_CODE_MISMATCH" && codigo !== CODIGOS_INCIDENTE_GATE[CODIGOS_INCIDENTE_GATE.length - 1]) {
        continue;
      }
      if (/^[A-Z0-9_]{3,60}$/.test(classe)) {
        throw new BloqueioExecucaoControladaError(classe, "Recuperação recusada — estado não elegível.");
      }
      throw error;
    }
  }
  throw new BloqueioExecucaoControladaError("ERROR_CODE_MISMATCH", "Recuperação recusada — estado não elegível.");
}

/**
 * Executa o worker LIVE run-once com pré-voo fail-closed. Nunca chama o Gmail
 * quando qualquer condição diverge; executa exatamente UMA iteração (sem loop,
 * sem retry — o motor classifica DELIVERY_UNKNOWN/AUTH_REQUIRED e para).
 *
 * CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED:
 *  - exige MAIL_PROVIDER=Gmail ANTES do claim — caso contrário responde sem
 *    mutação com PROVIDER_NOT_CONFIGURED (a tentativa falha anterior é
 *    integralmente preservada);
 *  - quando a outbox do teste já está FAILED, a execução só prossegue no
 *    cenário de retry exclusivo (FAILED + PROVIDER_NOT_CONFIGURED +
 *    tentativas=1 + zero receipts + ausência de provider message/thread id)
 *    após liberação auditada específica;
 *  - propaga {readiness, motivo} do motor e NUNCA reporta execução concluída
 *    quando sentItems=0 ou falhas>0.
 */
export async function executarWorkerControladoUmaVez(
  pool: PoolConsulta,
  politica: PoliticaControlada,
  executarLive: ExecucaoLiveControlada = executarWorkerUmaVezLive,
  opcoes: { providerGmailConfigurado?: boolean; retryAutorizado?: boolean } = {},
): Promise<ResultadoExecucaoControlada> {
  if (!politica.controlledMode) {
    throw new BloqueioExecucaoControladaError(
      "CONTROLLED_MODE_REQUIRED",
      "GMAIL_CONTROLLED_MODE inativo — execução LIVE controlada bloqueada.",
    );
  }
  if (!politica.realSendEnabled) {
    throw new BloqueioExecucaoControladaError(
      "REAL_SEND_DISABLED",
      "REAL_SEND_ENABLED=false — o envio real não está armado.",
    );
  }
  if (!politica.controlledRecipient) {
    throw new BloqueioExecucaoControladaError(
      "CONTROLLED_RECIPIENT_REQUIRED",
      "GMAIL_CONTROLLED_RECIPIENT ausente — executar apenas com REAL_SEND_ENABLED=false.",
    );
  }
  // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — bloqueio ANTES do claim: sem
  // Gmail o gateway real seria o desabilitado e a tentativa seria consumida
  // por uma falha pré-rede. Resposta sem mutação, com código sanitizado.
  if (opcoes.providerGmailConfigurado === false) {
    throw new BloqueioExecucaoControladaError(
      "PROVIDER_NOT_CONFIGURED",
      "MAIL_PROVIDER não é Gmail — execução real recusada antes de qualquer tentativa.",
    );
  }
  const preflight = await pool.query(
    `SELECT
      (SELECT count(*) FROM comunicacao c JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1) AS comunicacoes_teste,
      (SELECT c.id FROM comunicacao c JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 LIMIT 1) AS communication_id,
      (SELECT count(*) FROM comunicacao c WHERE c.provider = 'GMAIL') AS receipts_globais,
      (SELECT count(*) FROM lote_comunicacao l WHERE l.status = 'ATIVO' AND l.codigo <> $1) AS ativos_fora,
      (SELECT count(*) FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE o.status IN ('PENDING', 'FAILED') AND l.codigo <> $1) AS pendente_fora,
      (SELECT count(*) FROM outbox_email o WHERE o.status = 'PROCESSING') AS processamento,
      (SELECT modo FROM lote_comunicacao WHERE codigo = $1) AS modo,
      (SELECT status FROM lote_comunicacao WHERE codigo = $1) AS status_lote,
      (SELECT count(*) FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 AND o.status IN ('PENDING', 'FAILED')) AS teste_pendente,
      (SELECT o.status FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_status_teste,
      (SELECT o.tentativas FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_tentativas_teste,
      (SELECT o.ultimo_erro_codigo FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_erro_teste,
      (SELECT count(*) FROM comunicacao c
        WHERE c.lote_comunicacao_id = (SELECT id FROM lote_comunicacao WHERE codigo = $1)
          AND (c.provider_message_id IS NOT NULL OR c.provider_thread_id IS NOT NULL)) AS provider_ids_teste`,
    [CODIGO_LOTE_TESTE_CONTROLADO],
  );
  const p = preflight.rows[0] ?? {};
  if (Number(p.comunicacoes_teste ?? 0) !== 1) {
    throw new BloqueioExecucaoControladaError(
      "COMMUNICATION_COUNT_INVALID",
      `Lote controlado deve ter exatamente 1 comunicação (encontrado ${Number(p.comunicacoes_teste ?? 0)}).`,
    );
  }
  if (Number(p.receipts_globais ?? 0) > 0) {
    throw new BloqueioExecucaoControladaError(
      "RECEIPT_ALREADY_EXISTS",
      "Já existe receipt Gmail registrado — nenhum segundo envio é permitido.",
    );
  }
  if (Number(p.ativos_fora ?? 0) > 0) {
    throw new BloqueioExecucaoControladaError(
      "ACTIVE_BATCHES_OUTSIDE_TEST",
      `Lotes ATIVOS fora do teste: ${Number(p.ativos_fora)}.`,
    );
  }
  if (Number(p.pendente_fora ?? 0) > 0 || Number(p.processamento ?? 0) > 0) {
    throw new BloqueioExecucaoControladaError(
      "OUTBOX_NOT_SETTLED",
      "Outbox pendente/processing fora do teste — executar apenas com fila zerada.",
    );
  }
  if (p.modo !== "LIVE_PILOT" || p.status_lote !== "ATIVO") {
    throw new BloqueioExecucaoControladaError(
      "BATCH_NOT_ACTIVE",
      `Lote controlado deve estar ATIVO em LIVE_PILOT (atual: ${p.status_lote ?? "—"}/${p.modo ?? "—"}).`,
    );
  }
  // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — a outbox do teste precisa estar
  // PENDING (primeira execução) OU no cenário EXATO de retry pré-rede liberado
  // por autorização auditada. Qualquer outro estado (PROCESSING, outra falha,
  // mais de uma tentativa, provider ids presentes) é recusado sem mutação.
  const testePendente = Number(p.teste_pendente ?? 0);
  const retryCenario =
    String(p.outbox_status_teste ?? "") === "FAILED" &&
    String(p.outbox_erro_teste ?? "") === CODIGO_RETRY_PRE_REDE &&
    Number(p.outbox_tentativas_teste ?? 0) === 1 &&
    Number(p.provider_ids_teste ?? 0) === 0;
  if (testePendente === 1 && retryCenario) {
    if (opcoes.retryAutorizado !== true) {
      throw new BloqueioExecucaoControladaError(
        "RETRY_NOT_AUTHORIZED",
        "Outbox do teste está FAILED por PROVIDER_NOT_CONFIGURED — nova tentativa exige liberação auditada específica.",
      );
    }
    // Retry liberado: segue para o claim.
  } else if (testePendente === 1) {
    if (String(p.outbox_status_teste ?? "") !== "PENDING") {
      throw new BloqueioExecucaoControladaError(
        "OUTBOX_NOT_PENDING",
        `Outbox do teste em estado não reexecutável (${String(p.outbox_status_teste ?? "?")}/${String(p.outbox_erro_teste ?? "—")}) — nenhuma repetição é permitida.`,
      );
    }
    // Primeira execução: outbox PENDING, segue para o claim.
  } else {
    throw new BloqueioExecucaoControladaError(
      "OUTBOX_NOT_PENDING",
      "Outbox do teste não está elegível — nenhuma reexecução é permitida.",
    );
  }

  // EXATAMENTE UMA execução run-once. O motor LIVE aplica GATE 1/2 e o gate
  // controlado por comunicação (fonte + destinatário) imediatamente antes de
  // users.messages.send; nenhum retry automático acontece.
  const live = await executarLive({ env: process.env });
  const motivoBloqueio = live.motivo ?? null;

  const posflight = await pool.query(
    `SELECT c.id AS communication_id, c.status AS estado,
      (SELECT count(*) FROM comunicacao c2 WHERE c2.provider = 'GMAIL') AS receipts_globais,
      (SELECT o.status FROM outbox_email o WHERE o.comunicacao_id = c.id
        ORDER BY o.criada_em DESC LIMIT 1) AS outbox_status,
      (SELECT o.tentativas FROM outbox_email o WHERE o.comunicacao_id = c.id
        ORDER BY o.criada_em DESC LIMIT 1) AS outbox_tentativas,
      (SELECT o.ultimo_erro_codigo FROM outbox_email o WHERE o.comunicacao_id = c.id
        ORDER BY o.criada_em DESC LIMIT 1) AS outbox_erro,
      (c.provider_message_id IS NOT NULL) AS message_id_presente,
      (c.provider_thread_id IS NOT NULL) AS thread_id_presente
    FROM comunicacao c
    JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
    WHERE l.codigo = $1
    LIMIT 1`,
    [CODIGO_LOTE_TESTE_CONTROLADO],
  );
  const s = posflight.rows[0] ?? {};
  const recebidas = Number(s.receipts_globais ?? 0);
  const enviados = recebidas > 0 ? 1 : 0;
  const statusOutbox = String(s.outbox_status ?? "UNKNOWN");
  const estadoComunicacao = String(s.estado ?? "UNKNOWN");
  return {
    executionMode: "CONTROLLED_GMAIL_TEST",
    communicationId: String(s.communication_id ?? ""),
    estadoComunicacao,
    sentItems: enviados,
    falhas: enviados === 0 ? 1 : 0,
    // CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — "executado" é verdadeiro
    // SOMENTE quando o motor rodou sem bloqueio; o chamador NUNCA deve
    // anunciar "execução concluída" quando sentItems=0 ou falhas>0.
    executado: motivoBloqueio === null && enviados > 0,
    motivoBloqueio,
    statusOutbox,
    tentativas: Number(s.outbox_tentativas ?? 0),
    erroCodigo: s.outbox_erro === null || s.outbox_erro === undefined ? null : String(s.outbox_erro),
    messageIdPresente: s.message_id_presente === true,
    threadIdPresente: s.thread_id_presente === true,
  };
}

/**
 * CORRECTIVE_GATE_PROVIDER_NOT_CONFIGURED — liberação de NOVA TENTATIVA
 * exclusiva para o erro comprovadamente pré-rede. O estado é lido do banco:
 * só passa quando a outbox do teste está FAILED com PROVIDER_NOT_CONFIGURED,
 * tentativas=1, zero receipts Gmail e ausência de provider message/thread id.
 * DELIVERY_UNKNOWN, AUTH_REQUIRED, FAILED_PERMANENT, PROCESSING ou qualquer
 * falha pós-rede NUNCA são elegíveis.
 */
export function validarRetryPreRede(p: {
  outbox_status_teste?: string | null;
  outbox_erro_teste?: string | null;
  outbox_tentativas_teste?: number | string | null;
  receipts_globais?: number | string | null;
  provider_ids_teste?: number | string | null;
  status_lote?: string | null;
}): void {
  const elegivel =
    String(p.status_lote ?? "") === "ATIVO" &&
    String(p.outbox_status_teste ?? "") === "FAILED" &&
    String(p.outbox_erro_teste ?? "") === CODIGO_RETRY_PRE_REDE &&
    Number(p.outbox_tentativas_teste ?? 0) === 1 &&
    Number(p.receipts_globais ?? 0) === 0 &&
    Number(p.provider_ids_teste ?? 0) === 0;
  if (!elegivel) {
    throw new BloqueioExecucaoControladaError(
      "RETRY_NOT_ELIGIBLE",
      "Nova tentativa permitida exclusivamente para FAILED+PROVIDER_NOT_CONFIGURED+tentativas=1+receipt=0+sem provider ids.",
    );
  }
}

/**
 * Registra o evento auditado da nova autorização humana (PF_CONTROLLED_RETRY_AUTORIZADO)
 * e devolve o estado atualizado. Nenhum UPDATE de status, nenhum DELETE.
 */
export async function autorizarRetryPreRede(
  pool: PoolConsulta,
  operador: string,
): Promise<{ autorizado: boolean }> {
  const preflight = await pool.query(
    `SELECT
      (SELECT count(*) FROM comunicacao c WHERE c.provider = 'GMAIL') AS receipts_globais,
      (SELECT status FROM lote_comunicacao WHERE codigo = $1) AS status_lote,
      (SELECT o.status FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_status_teste,
      (SELECT o.tentativas FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_tentativas_teste,
      (SELECT o.ultimo_erro_codigo FROM outbox_email o
        JOIN comunicacao c ON c.id = o.comunicacao_id
        JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
        WHERE l.codigo = $1 ORDER BY o.criada_em DESC LIMIT 1) AS outbox_erro_teste,
      (SELECT count(*) FROM comunicacao c
        WHERE c.lote_comunicacao_id = (SELECT id FROM lote_comunicacao WHERE codigo = $1)
          AND (c.provider_message_id IS NOT NULL OR c.provider_thread_id IS NOT NULL)) AS provider_ids_teste`,
    [CODIGO_LOTE_TESTE_CONTROLADO],
  );
  validarRetryPreRede(preflight.rows[0] ?? {});
  const agora = new Date().toISOString();
  const loteId = await pool.query(
    `SELECT id FROM lote_comunicacao WHERE codigo = $1 LIMIT 1`,
    [CODIGO_LOTE_TESTE_CONTROLADO],
  );
  await pool.query(
    `INSERT INTO evento_auditoria (
      id, agregado_tipo, agregado_id, tipo, ator_id, ocorreu_em,
      metadados, hash_anterior, hash_evento
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULL, $8)`,
    [
      randomUUID(),
      "LOTE_COMUNICACAO",
      String(loteId.rows[0]?.id ?? ""),
      "PF_CONTROLLED_RETRY_AUTORIZADO",
      operador,
      agora,
      JSON.stringify({ motivo: CODIGO_RETRY_PRE_REDE, finalidade: "nova-tentativa-controlada-pre-rede" }),
      hashEvento(CODIGO_LOTE_TESTE_CONTROLADO, agora),
    ],
  );
  return { autorizado: true };
}

const MARCADOR_SNAPSHOT_SINTETICO = JSON.stringify({
  documento: MARCADOR_DOCUMENTO_SINTETICO,
  nome: NOME_SINTETICO,
  // Sem e-mail/telefone/endereço: o registro sintético fica visivelmente
  // inerte no cockpit institucional ("E-mail inválido") e fora dos fluxos de
  // contato — o destinatário do teste vem EXCLUSIVAMENTE do ambiente controlado.
  email: "",
  telefone: "",
  endereco: {},
  enderecoOrigem: "",
  enderecoInformado: false,
});

/**
 * Garante o profissional sintético do teste (idempotente por fingerprint do
 * marcador). Status PENDENCIA_TRIAGEM: NUNCA elegível a contato institucional —
 * somente o lote controlado o referencia.
 */
async function garantirProfissionalSintetico(
  pool: PoolConsulta,
  caixa: { seal(plaintext: string, context: string): EncryptedValue },
  fingerprinter: { fingerprint(namespace: string, valor: string): string },
  operador: string,
  agora: string,
): Promise<string> {
  const documentoFingerprint = fingerprinter.fingerprint("documento-sintetico", MARCADOR_DOCUMENTO_SINTETICO);
  const existente = await pool.query(
    `SELECT id FROM profissional WHERE origem = 'PF' AND documento_fingerprint = $1 LIMIT 1`,
    [documentoFingerprint],
  );
  const existenteId = existente.rows[0]?.id;
  if (existenteId) return existenteId;

  const profissionalId = randomUUID();
  const documento = caixa.seal(MARCADOR_DOCUMENTO_SINTETICO, "documento:cpf");
  const snapshot = caixa.seal(MARCADOR_SNAPSHOT_SINTETICO, "snapshot:original");
  await pool.query(
    `INSERT INTO profissional (
      id, origem, codigo_operacional, tipo_documento,
      documento_ciphertext, documento_nonce, documento_auth_tag, documento_chave_versao,
      documento_fingerprint, status
    ) VALUES ($1, 'PF', $2, 'CPF', $3, $4, $5, $6, $7, 'PENDENCIA_TRIAGEM')`,
    [
      profissionalId,
      CODIGO_PROFISSIONAL_SINTETICO,
      Buffer.from(documento.ciphertext),
      Buffer.from(documento.nonce),
      Buffer.from(documento.authTag),
      documento.keyVersion,
      documentoFingerprint,
    ],
  );
  await pool.query(
    `INSERT INTO snapshot_cadastral (
      profissional_id, tipo, conteudo_ciphertext, conteudo_nonce,
      conteudo_auth_tag, chave_versao, fonte
    ) VALUES ($1, 'ORIGINAL', $2, $3, $4, $5, 'IMPORTACAO')`,
    [
      profissionalId,
      Buffer.from(snapshot.ciphertext),
      Buffer.from(snapshot.nonce),
      Buffer.from(snapshot.authTag),
      snapshot.keyVersion,
    ],
  );
  await pool.query(
    `INSERT INTO evento_auditoria (
      id, agregado_tipo, agregado_id, tipo, ator_id, ocorreu_em,
      metadados, hash_anterior, hash_evento
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULL, $8)`,
    [
      randomUUID(),
      "PROFISSIONAL",
      profissionalId,
      "PF_PROFISSIONAL_SINTETICO_CRIADO",
      operador,
      agora,
      JSON.stringify({ codigoOperacional: CODIGO_PROFISSIONAL_SINTETICO, finalidade: "teste-controlado-gmail" }),
      hashEvento(profissionalId, agora),
    ],
  );
  return profissionalId;
}
