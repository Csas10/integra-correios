/**
 * SLICE-02 — Persistência operacional da campanha aprovada (migration 0007).
 *
 * Duas ações transacionais ÚNICAS e fail-fast:
 *   1. persistirCampanhaAprovada: campanha + decisões humanas + auditoria;
 *   2. persistirLoteCampanha (papel EXECUTOR): lote produtivo (PREPARACAO) +
 *      vínculo campanha→lote + outbox própria em HOLD (NÃO capturável pelo
 *      worker) + auditoria.
 * Qualquer falha = ROLLBACK integral — nada fica parcialmente persistido.
 *
 * Idempotência por (fingerprint_arquivo, hash_aprovacao): repetir a chamada
 * com o mesmo conteúdo NÃO duplica campanha, lote nem outbox (prova SQL 0004
 * e teste HTTP). Hash e snapshot são SEMPRE reconstruídos no servidor — o
 * navegador não tem autoridade sobre estado, hash ou operator_id.
 *
 * A outbox da campanha é ISOLADA da fila produtiva outbox_email: o worker
 * (claimOutbox) captura apenas outbox_email de lote ATIVO — aqui nada nasce
 * capturável enquanto canExecute=false. Nenhum e-mail é enviado neste fluxo.
 */

import { createHmac, randomUUID } from "node:crypto";
import {
  CAMPAIGN_TEMPLATE_VERSAO_PADRAO,
  codigoLoteCampanha,
  hashDoSnapshotCampanha,
  snapshotCampanha,
  type CampaignPersistDecisao,
  type CampaignPersistRegistro,
} from "./campaigns.js";

export type { CampaignPersistDecisao, CampaignPersistRegistro } from "./campaigns.js";

/** Pool mínimo usado aqui (Node postgres ou transação de teste). */
export interface CampanhaSqlExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly any[]; rowCount: number | null }>;
}

export interface CampanhaPool {
  connect(): Promise<CampanhaSqlExecutor & { release(): void }>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly any[]; rowCount: number | null }>;
}

export class CampaignPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CampaignPersistenceError";
    this.code = code;
  }
}

export type CampaignPersistOutcome =
  | { readonly resultado: "CRIADA"; readonly campanhaId: string; readonly hashAprovacao: string }
  | { readonly resultado: "EXISTENTE"; readonly campanhaId: string; readonly hashAprovacao: string };

export interface PersistCampanhaCommand {
  readonly operatorId: string;
  readonly fingerprintArquivo: string;
  readonly registros: readonly CampaignPersistRegistro[];
  readonly decisoes: readonly CampaignPersistDecisao[];
  readonly templateVersao?: string;
}

export interface EstadoCampanhaPersistida {
  readonly campanhaId: string;
  readonly operatorId: string;
  readonly fingerprintArquivo: string;
  readonly templateVersao: string;
  readonly hashAprovacao: string;
  readonly estado: string;
  readonly totalRegistros: number;
  readonly totalAptos: number;
  readonly totalBloqueados: number;
  readonly totalAprovados: number;
  readonly loteId: string | null;
  readonly loteCodigo: string | null;
  readonly loteEstado: string | null;
  readonly outboxTotal: number;
  readonly outboxNaoExecutavel: number;
  readonly criadaEm: string;
}

function assertFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CampaignPersistenceError(
      "CAMPAIGN_INPUT_INVALID",
      "Fingerprint do arquivo deve ser SHA-256 hexadecimal.",
    );
  }
}

function assertRegistros(registros: readonly CampaignPersistRegistro[]): void {
  if (registros.length === 0 || registros.length > 20_000) {
    throw new CampaignPersistenceError(
      "CAMPAIGN_INPUT_INVALID",
      "Campanha sem registros aprovados ou acima do limite operacional.",
    );
  }
  for (const registro of registros) {
    if (
      typeof registro.profissional_id !== "string" ||
      registro.profissional_id.trim() === "" ||
      typeof registro.nome !== "string" ||
      registro.nome.trim() === "" ||
      typeof registro.email_normalizado !== "string" ||
      registro.email_normalizado.trim() === "" ||
      registro.status_validacao !== "APTO"
    ) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_INPUT_INVALID",
        "Registro aprovado inválido para persistência.",
      );
    }
  }
}

function assertDecisoes(decisoes: readonly CampaignPersistDecisao[]): void {
  const linhas = new Set<number>();
  for (const decisao of decisoes) {
    if (
      !Number.isSafeInteger(decisao.linha) ||
      decisao.linha < 1 ||
      (decisao.tipo !== "EXCLUSAO_HUMANA" && decisao.tipo !== "INCONSISTENCIA_JULGADA") ||
      typeof decisao.motivo !== "string" ||
      decisao.motivo.trim() === ""
    ) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_INPUT_INVALID",
        "Decisão humana inválida para persistência.",
      );
    }
    if (linhas.has(decisao.linha)) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_INPUT_INVALID",
        "Decisão humana duplicada para a mesma linha.",
      );
    }
    linhas.add(decisao.linha);
  }
}

/** Convenção de hash de auditoria do repositório (pilot.ts). */
function hashEvento(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}

/**
 * Persiste a campanha aprovada e materializa lote + outbox em HOLD, de forma
 * ATÔMICA e IDEMPOTENTE. `operatorId` vem exclusivamente da sessão autenticada
 * (exigido pela rota) — nunca do corpo da requisição.
 */
export async function persistirCampanhaAprovada(
  pool: CampanhaPool,
  command: PersistCampanhaCommand,
): Promise<CampaignPersistOutcome> {
  const fingerprint = command.fingerprintArquivo.trim().toLowerCase();
  assertFingerprint(fingerprint);
  assertRegistros(command.registros);
  assertDecisoes(command.decisoes);

  const templateVersao = command.templateVersao?.trim() || CAMPAIGN_TEMPLATE_VERSAO_PADRAO;
  const snapshot = snapshotCampanha({
    fingerprintArquivo: fingerprint,
    templateVersao,
    registros: command.registros,
    decisoes: command.decisoes,
  });
  const hashAprovacao = hashDoSnapshotCampanha(snapshot);
  if (snapshot.total_aprovados <= 0) {
    throw new CampaignPersistenceError(
      "CAMPAIGN_NOT_APPROVED",
      "Nenhum registro aprovado após decisões humanas.",
    );
  }

  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");

    // Idempotência estrutural: mesmo (fingerprint, hash) devolve o estado
    // existente sem duplicar lote/outbox/auditoria.
    const existente = await transaction.query(
      `SELECT id, hash_aprovacao FROM campanha_persistida
       WHERE fingerprint_arquivo = $1 AND hash_aprovacao = $2
       FOR UPDATE`,
      [fingerprint, hashAprovacao],
    );
    if (existente.rows[0]) {
      await transaction.query("COMMIT");
      return {
        resultado: "EXISTENTE",
        campanhaId: existente.rows[0].id,
        hashAprovacao,
      };
    }

    const campanhaId = randomUUID();
    const agora = new Date().toISOString();

    await transaction.query(
      `INSERT INTO campanha_persistida (
        id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
        snapshot_registros, total_registros, total_aptos, total_bloqueados,
        total_aprovados, decisoes_humanas, estado, criada_em, atualizada_em
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, 'APROVADA', $12, $12)`,
      [
        campanhaId,
        command.operatorId,
        fingerprint,
        templateVersao,
        hashAprovacao,
        JSON.stringify(snapshot),
        snapshot.total_registros,
        snapshot.total_aptos,
        snapshot.total_bloqueados,
        snapshot.total_aprovados,
        JSON.stringify(snapshot.decisoes_humanas),
        agora,
      ],
    );

    for (const decisao of command.decisoes) {
      await transaction.query(
        `INSERT INTO campanha_decisao (
          id, campanha_id, operator_id, linha, profissional_id, tipo, motivo, criada_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          campanhaId,
          command.operatorId,
          decisao.linha,
          decisao.profissional_id,
          decisao.tipo,
          decisao.motivo,
          agora,
        ],
      );
    }

    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_PERSISTIDA', $1, 'CAMPAIGN_PERSISTIDA', $2, $2, $3, $4::jsonb, NULL, $5)`,
      [
        campanhaId,
        command.operatorId,
        agora,
        JSON.stringify({
          total_registros: snapshot.total_registros,
          total_aprovados: snapshot.total_aprovados,
          decisoes: command.decisoes.length,
        }),
        hashEvento(campanhaId, agora),
      ],
    );

    await transaction.query("COMMIT");
    return { resultado: "CRIADA", campanhaId, hashAprovacao };
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original; a conexão será liberada abaixo.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

/**
 * Reconstrói o estado persistido a partir do PostgreSQL (etapa 10 da jornada:
 * reload/logout não pode apagar a campanha). Sem PII além dos contadores.
 */
export async function recuperarEstadoCampanha(
  pool: CampanhaPool,
  consulta: {
    readonly fingerprintArquivo?: string;
    readonly hashAprovacao?: string;
    readonly operatorId?: string;
  },
): Promise<EstadoCampanhaPersistida | undefined> {
  const params: unknown[] = [];
  const filtros: string[] = [];
  if (consulta.fingerprintArquivo) {
    const fingerprint = consulta.fingerprintArquivo.trim().toLowerCase();
    assertFingerprint(fingerprint);
    params.push(fingerprint);
    filtros.push(`c.fingerprint_arquivo = $${params.length}`);
  }
  if (consulta.hashAprovacao) {
    params.push(consulta.hashAprovacao.trim().toLowerCase());
    filtros.push(`c.hash_aprovacao = $${params.length}`);
  }
  if (consulta.operatorId) {
    params.push(consulta.operatorId);
    filtros.push(`c.operator_id = $${params.length}`);
  }
  if (filtros.length === 0) {
    throw new CampaignPersistenceError(
      "CAMPAIGN_INPUT_INVALID",
      "Informe ao menos um critério de recuperação (hash e/ou fingerprint).",
    );
  }
  const filtro = filtros.join(" AND ");

  const resultado = await pool.query(
    `SELECT c.id AS campanha_id, c.operator_id, c.fingerprint_arquivo,
            c.template_versao, c.hash_aprovacao, c.estado,
            c.total_registros, c.total_aptos, c.total_bloqueados, c.total_aprovados,
            c.criada_em,
            lc.id AS lote_id, lc.codigo AS lote_codigo, lc.estado AS lote_estado,
            (SELECT count(*)::text FROM outbox_campanha o WHERE o.lote_campanha_id = lc.id) AS outbox_total,
            (SELECT count(*)::text FROM outbox_campanha o
              WHERE o.lote_campanha_id = lc.id AND o.estado IN ('HOLD','PREPARADO')) AS outbox_nao_executavel
       FROM campanha_persistida c
       LEFT JOIN lote_campanha lc ON lc.campanha_id = c.id
      WHERE ${filtro}
      ORDER BY c.criada_em DESC
      LIMIT 1`,
    params,
  );

  const linha = resultado.rows[0];
  if (!linha) return undefined;
  return {
    campanhaId: linha.campanha_id,
    operatorId: linha.operator_id,
    fingerprintArquivo: linha.fingerprint_arquivo,
    templateVersao: linha.template_versao,
    hashAprovacao: linha.hash_aprovacao,
    estado: linha.estado,
    totalRegistros: linha.total_registros,
    totalAptos: linha.total_aptos,
    totalBloqueados: linha.total_bloqueados,
    totalAprovados: linha.total_aprovados,
    loteId: linha.lote_id,
    loteCodigo: linha.lote_codigo,
    loteEstado: linha.lote_estado,
    outboxTotal: Number(linha.outbox_total ?? 0),
    outboxNaoExecutavel: Number(linha.outbox_nao_executavel ?? 0),
    criadaEm: linha.criada_em,
  };
}


export interface CriarLoteCampanhaCommand {
  readonly campanhaId: string;
  readonly operatorId: string;
  readonly hashSubmetido: string;
}

export interface LoteCampanhaResultado {
  readonly resultado: "CRIADO" | "EXISTENTE";
  readonly loteCampanhaId: string;
  readonly loteCodigo: string;
  readonly estado: string;
  readonly totalItens: number;
  readonly outboxTotal: number;
  readonly outboxNaoExecutavel: number;
}

/**
 * Cria o lote controlado da campanha APROVADA (ação do papel EXECUTOR,
 * autorizada na rota) e materializa a outbox em HOLD — NÃO capturável pelo
 * worker. Idempotente: lote já existente é devolvido sem duplicar nada.
 * O hash submetido é confrontado com o hash CONGELADO da campanha (409 stale
 * em caso de divergência); operator_id vem da sessão autenticada.
 */
export async function persistirLoteCampanha(
  pool: CampanhaPool,
  command: CriarLoteCampanhaCommand,
): Promise<LoteCampanhaResultado> {
  const hashSubmetido = command.hashSubmetido.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hashSubmetido)) {
    throw new CampaignPersistenceError(
      "CAMPAIGN_BATCH_INVALID",
      "conteudoHash deve ser SHA-256 hexadecimal.",
    );
  }
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");

    const campanha = await transaction.query(
      `SELECT id, operator_id, hash_aprovacao, fingerprint_arquivo, template_versao,
              estado, snapshot_registros
         FROM campanha_persistida
        WHERE id = $1
        FOR UPDATE`,
      [command.campanhaId],
    );
    const campanhaLinha = campanha.rows[0];
    if (!campanhaLinha) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_PERSISTED_NOT_FOUND",
        "Campanha persistida não encontrada.",
      );
    }
    if (campanhaLinha.hash_aprovacao !== hashSubmetido) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_APPROVAL_STALE",
        "Hash submetido diverge do hash congelado da campanha.",
      );
    }

    const existente = await transaction.query(
      `SELECT id, codigo, estado, total_itens FROM lote_campanha
        WHERE campanha_id = $1
        LIMIT 1`,
      [command.campanhaId],
    );
    if (existente.rows[0]) {
      const outbox = await transaction.query(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE estado IN ('HOLD','PREPARADO'))::text AS hold
           FROM outbox_campanha
          WHERE lote_campanha_id = $1`,
        [existente.rows[0].id],
      );
      await transaction.query("COMMIT");
      return {
        resultado: "EXISTENTE",
        loteCampanhaId: existente.rows[0].id,
        loteCodigo: existente.rows[0].codigo,
        estado: existente.rows[0].estado,
        totalItens: existente.rows[0].total_itens,
        outboxTotal: Number(outbox.rows[0]?.total ?? 0),
        outboxNaoExecutavel: Number(outbox.rows[0]?.hold ?? 0),
      };
    }

    const registrosAptos = campanhaLinha.snapshot_registros.registros ?? [];
    if (registrosAptos.length === 0) {
      throw new CampaignPersistenceError(
        "CAMPAIGN_NOT_APPROVED",
        "Campanha sem registros aprovados no snapshot congelado.",
      );
    }

    const agora = new Date().toISOString();
    const loteProdutivoId = randomUUID();
    const loteCampanhaId = randomUUID();
    const loteCodigo = codigoLoteCampanha(campanhaLinha.fingerprint_arquivo);

    await transaction.query(
      `INSERT INTO lote_comunicacao (
        id, origem, codigo, template_versao, status, criado_por, criado_em
      ) VALUES ($1, 'PF', $2, $3, 'PREPARACAO', $4, $5)`,
      [loteProdutivoId, loteCodigo, campanhaLinha.template_versao, command.operatorId, agora],
    );
    await transaction.query(
      `INSERT INTO lote_campanha (
        id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em
      ) VALUES ($1, $2, 'PF', $3, $4, 'HOLD', $5, $6)`,
      [
        loteCampanhaId,
        command.campanhaId,
        loteCodigo,
        campanhaLinha.template_versao,
        registrosAptos.length,
        agora,
      ],
    );
    await transaction.query(
      `INSERT INTO campanha_lote (campanha_id, lote_comunicacao_id, origem, criado_em)
       VALUES ($1, $2, 'PF', $3)`,
      [command.campanhaId, loteProdutivoId, agora],
    );

    for (let ordem = 1; ordem <= registrosAptos.length; ordem += 1) {
      const registro = registrosAptos[ordem - 1]!;
      const comunicacaoId = randomUUID();
      await transaction.query(
        `INSERT INTO comunicacao (
          id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
          destinatario_fingerprint, template_versao, idempotency_key, status, fonte_registro, criada_em
        ) VALUES ($1, $2, $1, $3, 'PF', 'PENDING', $4, $5, $6, 'QUEUED', 'CAMPANHA_PF', $7)`,
        [
          comunicacaoId,
          registro.profissional_id,
          loteProdutivoId,
          campanhaLinha.hash_aprovacao,
          campanhaLinha.template_versao,
          `${campanhaLinha.hash_aprovacao}:${ordem}`,
          agora,
        ],
      );
      await transaction.query(
        `INSERT INTO item_lote_comunicacao (
          lote_comunicacao_id, profissional_id, comunicacao_id, origem, status, criado_em, atualizado_em
        ) VALUES ($1, $2, $3, 'PF', 'RESERVADO', $4, $4)`,
        [loteProdutivoId, registro.profissional_id, comunicacaoId, agora],
      );
      await transaction.query(
        `INSERT INTO outbox_campanha (
          id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em
        ) VALUES ($1, $2, $3, $4, $5::jsonb, 'HOLD', $6)`,
        [
          randomUUID(),
          loteCampanhaId,
          ordem,
          registro.email_normalizado,
          JSON.stringify({
            template_versao: campanhaLinha.template_versao,
            hash_aprovacao: campanhaLinha.hash_aprovacao,
            ordem,
          }),
          agora,
        ],
      );
    }

    await transaction.query(
      `UPDATE campanha_persistida SET estado = 'LOTE_CRIADO', atualizada_em = $2 WHERE id = $1`,
      [command.campanhaId, agora],
    );

    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_PERSISTIDA', $2, 'CAMPAIGN_LOTE_CRIADO', $3, $3, $4, $5::jsonb, NULL, $6)`,
      [
        randomUUID(),
        command.campanhaId,
        command.operatorId,
        agora,
        JSON.stringify({
          lote_codigo: loteCodigo,
          total_itens: registrosAptos.length,
          outbox_estado: "HOLD",
        }),
        hashEvento(loteCampanhaId, agora),
      ],
    );

    await transaction.query("COMMIT");
    return {
      resultado: "CRIADO",
      loteCampanhaId,
      loteCodigo,
      estado: "HOLD",
      totalItens: registrosAptos.length,
      outboxTotal: registrosAptos.length,
      outboxNaoExecutavel: registrosAptos.length,
    };
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original; a conexão será liberada abaixo.
    }
    throw error;
  } finally {
    transaction.release();
  }
}
