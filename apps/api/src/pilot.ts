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
  type EncryptedValue,
} from "@integra-correios/persistence";

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
