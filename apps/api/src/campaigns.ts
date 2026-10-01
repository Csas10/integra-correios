import { createHash } from "node:crypto";
import {
  contentHashDoTemplate as contentHashDoTemplateNoRegistry,
  TEMPLATE_V1_VERSION,
  selecionarTemplateCampanhaNova as selecionarTemplateNoRegistry,
  TEMPLATE_REGISTRY,
  TEMPLATE_SCOPE_PF_CAMPAIGN,
} from "@integra-correios/mail";

export const PF_UPDATE_CAMPAIGN_CODE_PREFIX =
  "PF_ATUALIZACAO_CADASTRAL_" as const;
export { normalizarCampoExibicaoCampanha } from "./campaign-import.js";
export {
  metadadosTemplate as metadadosTemplateCampanha,
  TEMPLATE_REGISTRY as TEMPLATE_REGISTRY_CAMPANHA,
} from "@integra-correios/mail";

/** Entrada do catálogo server-driven de templates selecionáveis (UI). */
export interface ExibicaoCampanha {
  readonly templateVersao: string;
  readonly templateId: string;
  readonly status: "DRAFT" | "APPROVED" | "RETIRED";
  readonly scope: string;
  readonly subject: string;
  readonly dataMode: "RESPONSE_FORM" | "PREFILLED_CONFIRMATION";
}

/**
 * GF-2 FINAL — catálogo server-driven: SOMENTE entradas selecionáveis do
 * registry (status APPROVED no escopo PF_CAMPAIGN). A UI renderiza a lista
 * e o operador seleciona explicitamente uma versão registrada; não existe
 * default implícito no cliente e o servidor revalida em authorize/persist/
 * claim (SERVER_REGISTRY_AUTHORITY=true).
 */
export function campanhasSelecionaveisCampanha(): readonly ExibicaoCampanha[] {
  return TEMPLATE_REGISTRY.filter(
    (entrada) => entrada.scope === TEMPLATE_SCOPE_PF_CAMPAIGN && entrada.status === "APPROVED",
  ).map((entrada) => ({
    templateVersao: entrada.templateVersion,
    templateId: entrada.templateId,
    status: entrada.status,
    scope: entrada.scope,
    subject: entrada.subject,
    dataMode: entrada.dataMode,
  }));
}
/** Reexportado do módulo neutro pilot-domain (segurança Slice-03A.1). */
export { RESERVED_PILOT_BATCH_CODE } from "./pilot-domain.js";

export const PF_UPDATE_CAMPAIGN_STATES = [
  "PREPARACAO",
  "APROVADO",
  "ATIVO",
  "CONCLUIDO",
] as const;

export type PfUpdateCampaignState = (typeof PF_UPDATE_CAMPAIGN_STATES)[number];

/** Etapas da interface operacional /operacao/email (jornada fechada de 10 passos). */
export const PF_CAMPAIGN_STAGES = [
  "IDENTIFICACAO",
  "CAMPANHA",
  "IMPORTACAO",
  "MAPEAMENTO",
  "INCONSISTENCIAS",
  "REVISAO_PROFISSIONAIS",
  "PREVIA_MENSAGENS",
  "APROVACAO",
  "EXECUCAO_CONTROLADA",
  "ACOMPANHAMENTO",
] as const;

export type PfCampaignStage = (typeof PF_CAMPAIGN_STAGES)[number];

/** Papéis operacionais da campanha (contrato de database/migrations/0006). */
export type PfCampaignRole =
  | "PREPARADOR"
  | "REVISOR"
  | "APROVADOR"
  | "EXECUTOR"
  | "SUPERVISOR"
  | "ADMIN_TECNICO";

/**
 * Ações operacionais mutáveis da campanha. A autorização é SEMPRE avaliada
 * no servidor a partir dos papéis ativos da identidade individual; a UI
 * apenas espelha o resultado — ADMIN_TECNICO administra identidade e não
 * recebe poder operacional implícito.
 */
export const PF_CAMPAIGN_ACTIONS = [
  "IMPORTAR_E_MAPEAR",
  "RESOLVER_INCONSISTENCIAS",
  "APROVAR_E_CONGELAR",
  "EXECUTAR_LOTE",
  "ACOMPANHAR_PAUSAR_CANCELAR",
] as const;

export type PfCampaignAction = (typeof PF_CAMPAIGN_ACTIONS)[number];

export const PF_CAMPAIGN_ROLE_ACTIONS: Readonly<
  Record<PfCampaignRole, readonly PfCampaignAction[]>
> = {
  PREPARADOR: ["IMPORTAR_E_MAPEAR"],
  REVISOR: ["RESOLVER_INCONSISTENCIAS"],
  APROVADOR: ["APROVAR_E_CONGELAR"],
  EXECUTOR: ["EXECUTAR_LOTE"],
  SUPERVISOR: ["ACOMPANHAR_PAUSAR_CANCELAR"],
  ADMIN_TECNICO: [],
};

export function acoesCampanhaPorPapeis(
  roles: readonly string[],
): readonly PfCampaignAction[] {
  const acoes = new Set<PfCampaignAction>();
  for (const role of roles) {
    const permitidas = PF_CAMPAIGN_ROLE_ACTIONS[role as PfCampaignRole];
    if (permitidas) for (const acao of permitidas) acoes.add(acao);
  }
  return PF_CAMPAIGN_ACTIONS.filter((acao) => acoes.has(acao));
}

/** Motivos estáveis de bloqueio de ação (contrato UI↔API). */
export type PfCampaignBlockedActionReason =
  | "OPERATOR_ROLE_FORBIDDEN"
  | "CAMPAIGN_NOT_PREPARACAO"
  | "IMPORT_INVALID"
  | "APPROVAL_INVALIDATED"
  | "EXECUTION_NOT_READY";

/**
 * Capability gates da campanha. Defaults FALSE: nenhum gate abre por ausência
 * de configuração — somente flags explícitas de ambiente habilitam persistência
 * e lote controlado no Preview. Execução NÃO tem flag: permanece fechada até
 * gate dedicado futuro.
 */
export interface PfUpdateCampaignPolicy {
  readonly enabled: boolean;
  readonly phase: "FOUNDATION" | "PERSISTENCE";
  readonly individualOperatorIdentityRequired: true;
  readonly canPersistImport: boolean;
  readonly canCreateBatch: boolean;
  /**
   * Slice-03A.1: interpretado pela MESMA fronteira (autoridade única).
   * Default fail-closed: ausente/vazio/inválido ⇒ false. O valor só abre
   * com o literal homologado "true" — e o duplo gate com REAL_SEND_ENABLED
   * continua obrigatório na execução.
   */
  readonly canExecute: boolean;
  /**
   * Slice-03B: capacidade de PREPARAÇÃO do lote (HOLD → PREPARADO), SEMPRE
   * SEPARADA da execução. Default fail-closed: ausente ⇒ false. Preparar
   * NUNCA liga o Gmail: toca apenas lote_campanha/outbox_campanha (a outbox
   * PREPARADO continua não capturável — o claim exige lote ATIVO).
   */
  readonly canPrepareBatch: boolean;
  readonly realSendEnabled: boolean;
  /**
   * Slice-03C.2A: armar o caminho de envio do CANÁRIO (pré-condição
   * necessária, NUNCA suficiente). Leitura exclusiva desta fronteira —
   * nenhum outro módulo lê o ambiente diretamente para este flag. Default
   * fail-closed: ausente/vazio/"1"/"TRUE"/qualquer outro valor ⇒ false.
   */
  readonly canarySendEnabled: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function carregarPoliticaCampanhaAtualizacao(
  env: Environment = process.env,
): PfUpdateCampaignPolicy {
  return {
    enabled: env.PF_CAMPAIGN_ENABLED === "true",
    phase: env.PF_CAMPAIGN_PERSIST_ENABLED === "true" ? "PERSISTENCE" : "FOUNDATION",
    individualOperatorIdentityRequired: true,
    canPersistImport: env.PF_CAMPAIGN_PERSIST_ENABLED === "true",
    canCreateBatch: env.PF_CAMPAIGN_BATCH_ENABLED === "true",
    canExecute: env.PF_CAMPAIGN_EXECUTE_ENABLED === "true",
    canPrepareBatch: env.PF_CAMPAIGN_PREPARE_ENABLED === "true",
    realSendEnabled: env.REAL_SEND_ENABLED === "true",
    canarySendEnabled: env.PF_CAMPAIGN_CANARY_SEND_ENABLED === "true",
  };
}

export function codigoCampanhaAtualizacao(ano: number, sequencia: number): string {
  if (!Number.isSafeInteger(ano) || ano < 2026 || ano > 9999) {
    throw new Error("Ano da campanha inválido");
  }
  if (!Number.isSafeInteger(sequencia) || sequencia < 1 || sequencia > 99) {
    throw new Error("Sequência da campanha deve estar entre 1 e 99");
  }
  return `${PF_UPDATE_CAMPAIGN_CODE_PREFIX}${ano}_${String(sequencia).padStart(2, "0")}`;
}

/**
 * Contratos do hash de aprovação (GF-2 CORRETIVO):
 * · CAMPANHA_APROVACAO_V1 — algoritmo HISTÓRICO preservado byte a byte
 *   (template + contentHash opcional + profissional_id/nome/e-mail/status por
 *   registro). NENHUM hash histórico muda; nenhum secret/HMAC retroativo.
 * · CAMPANHA_APROVACAO_V2 — SHA-256 domain-separated sobre representação
 *   canônica VERSIONADA que inclui TODOS os campos que podem aparecer na
 *   mensagem (nome, e-mail, status + telefone, CEP, logradouro, número,
 *   complemento, bairro, cidade, UF) + templateVersion + templateContentHash.
 *   Ausência de campo ⇒ null canônico explícito (nunca colisão ausente/vazio).
 * A versão do contrato é persistida no snapshot JSONB (sem migration) via
 * `approval_hash_version` — fail-closed: campanha v2 sem marcador V2 é
 * BLOQUEADA; NUNCA há downgrade V2→V1 nem "o algoritmo que der certo".
 */
export const CAMPANHA_APROVACAO_V1 = "CAMPANHA_APROVACAO_V1" as const;
export const CAMPANHA_APROVACAO_V2 = "CAMPANHA_APROVACAO_V2" as const;
export type ContratoHashAprovacao =
  | typeof CAMPANHA_APROVACAO_V1
  | typeof CAMPANHA_APROVACAO_V2;

export interface RegistroHashAprovacao {
  readonly profissional_id: string;
  readonly nome: string;
  readonly email_normalizado: string;
  readonly status_validacao: string;
  /**
   * GF-2 CORRETIVO — SOURCE RECORD KEY opaca (server-side, sem PII) quando
   * fornecida; ausente ⇒ null canônico. `undefined` explícito (EOPT-friendly).
   */
  readonly source_record_key?: string | undefined;
  /**
   * GF-2 CORRETIVO — campos PREFILLED entram na autorização (V2).
   * `undefined` explícito = ausente (null canônico no hash); EOPT-friendly.
   */
  readonly exibicao?: {
    readonly telefone?: string;
    readonly cep?: string;
    readonly logradouro?: string;
    readonly numero?: string;
    readonly complemento?: string;
    readonly bairro?: string;
    readonly cidade?: string;
    readonly uf?: string;
  } | undefined;
}

const CHAVES_EXIBICAO_HASH = [
  "telefone",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cidade",
  "uf",
] as const;

/**
 * V1 (histórica) — preservada BYTE/SEMANTICAMENTE. Campos de exibição NÃO
 * entram (comportamento publicado desde sempre em campanhas históricas);
 * contentHash permanece opcional (snapshots sem template_content_hash
 * permanecem válidos — NENHUM backfill).
 */
function hashAprovacaoCampanhaV1(input: {
  readonly templateVersao: string;
  readonly templateContentHash?: string;
  readonly registros: readonly {
    readonly profissional_id: string;
    readonly nome: string;
    readonly email_normalizado: string;
    readonly status_validacao: string;
  }[];
}): string {
  const sha256 = createHash("sha256");
  sha256.update(`template:${input.templateVersao}\n`);
  // GF-2 F4 — binding durável: o hash de aprovação congela TAMBÉM o
  // contentHash canônico do template. Snapshots históricos sem
  // template_content_hash permanecem válidos (campo opcional; NENHUM backfill).
  if (input.templateContentHash !== undefined) {
    sha256.update(`templateContentHash:${input.templateContentHash}\n`);
  }
  for (const registro of input.registros) {
    sha256.update(
      `${registro.profissional_id}\u001f${registro.nome}\u001f` +
        `${registro.email_normalizado}\u001f${registro.status_validacao}\n`,
    );
  }
  return sha256.digest("hex");
}

/**
 * GF-3 CORRECTIVE-02 (F4) — encoding de PRESENÇA tipado e inequívoco no
 * canônico V2 (PRE-LAUNCH: nenhuma campanha/outbox operacional V2 existe —
 * invariante do owner; sem migration, sem backfill).
 *   ABSENT  ⇒ marcador tipado explícito (NUNCA "null": colidia com a string
 *             permitida "null");
 *   PRESENT ⇒ marcador tipado + comprimento determinístico + valor EXATO
 *             ("s:<len>:<valor>"): a fronteira comprimento/valor é inequívoca
 *             mesmo com separador \u001f no valor, e undefined ≠ qualquer
 *             string permitida ≠ ausência.
 * A saída de validarSubmissaoAprovacao NUNCA contém string vazia (vazio ⇒
 * ausente), e a ordem de propriedades permanece irrelevante (escrita fixa).
 */
const MARCADOR_AUSENCIA_V2 = "\u0000AUSENTE\u0000";
const MARCADOR_PRESENCA_V2 = "s:";

function valorCanonicov2(valor: string | undefined): string {
  return valor === undefined ? MARCADOR_AUSENCIA_V2 : `${MARCADOR_PRESENCA_V2}${valor.length}:${valor}`;
}

/**
 * V2 — representação canônica inequívoca: namespace/versão + ordem FIXA de
 * campos por registro (sem HMAC/secret; templateContentHash, snapshotHash e
 * recipientFingerprint permanecem contratos DISTINTOS). Ordem incidental de
 * propriedades NÃO afeta o hash (escrita em ordem fixa); CR/LF/TAB já chegam
 * normalizados pela fronteira (whitespace → espaço único). GF-3
 * CORRECTIVE-02 (F4): campos ausentes usam marcador tipado de ausência e
 * campos presentes usam marcador tipado + comprimento — V1 permanece
 * byte-a-byte inalterado.
 */
function hashAprovacaoCampanhaV2(input: {
  readonly templateVersao: string;
  readonly templateContentHash: string;
  readonly registros: readonly RegistroHashAprovacao[];
}): string {
  const sha256 = createHash("sha256");
  sha256.update("integra-correios:approval-hash:CAMPANHA_APROVACAO_V2\n");
  sha256.update(`templateVersion=${input.templateVersao}\n`);
  sha256.update(`templateContentHash=${input.templateContentHash}\n`);
  sha256.update(`totalRegistros=${input.registros.length}\n`);
  for (const registro of input.registros) {
    sha256.update(
      [
        registro.profissional_id,
        registro.nome,
        registro.email_normalizado,
        registro.status_validacao,
        valorCanonicov2(registro.source_record_key),
        ...CHAVES_EXIBICAO_HASH.map(
          (chave) => valorCanonicov2(registro.exibicao?.[chave]),
        ),
      ].join("\u001f") + "\n",
    );
  }
  return sha256.digest("hex");
}

/**
 * Hash de aprovação com CONTRATO EXPLÍCITO (GF-2 CORRETIVO). `contrato`
 * omitido = V1 (algoritmo histórico byte a byte, compatibilidade de
 * reconstrução histórica); `CAMPANHA_APROVACAO_V2` = representação canônica
 * versionada com TODOS os campos PREFILLED. Sem fallback implícito entre
 * contratos: quem chama declara o contrato — nunca "o algoritmo que der certo".
 */
export function hashAprovacaoCampanha(input: {
  readonly contrato?: ContratoHashAprovacao;
  readonly templateVersao: string;
  /** Hash canônico do CONTEÚDO do template (registry) — GF-2 F4. */
  readonly templateContentHash?: string;
  readonly registros: readonly RegistroHashAprovacao[];
}): string {
  if (input.contrato === CAMPANHA_APROVACAO_V2) {
    if (input.templateContentHash === undefined) {
      throw new Error("CAMPANHA_APROVACAO_V2 exige templateContentHash.");
    }
    return hashAprovacaoCampanhaV2({
      templateVersao: input.templateVersao,
      templateContentHash: input.templateContentHash,
      registros: input.registros,
    });
  }
  return hashAprovacaoCampanhaV1({
    templateVersao: input.templateVersao,
    ...(input.templateContentHash === undefined
      ? {}
      : { templateContentHash: input.templateContentHash }),
    registros: input.registros,
  });
}

/**
 * Resolução FAIL-CLOSED do contrato de um hash persistido (GF-2 CORRETIVO):
 * marcador explícito vence; campanha v2 SEM marcador ⇒ BLOQUEADA (nunca
 * downgrade para V1); campanha histórica (v1) sem marcador ⇒ V1 somente se
 * compatível com o template histórico registrado (v1 RETIRED). Nunca
 * "o algoritmo que der certo".
 */
export function resolverContratoHashAprovacao(input: {
  readonly templateVersao: string;
  readonly approvalHashVersion?: unknown;
}): ContratoHashAprovacao {
  if (input.approvalHashVersion !== undefined && input.approvalHashVersion !== null) {
    if (input.approvalHashVersion === CAMPANHA_APROVACAO_V1) {
      // V1 somente é compatível com a campanha histórica v1 (RETIRED):
      // marcador V1 em campanha v2 é contradição fail-closed (NUNCA downgrade).
      if (input.templateVersao.trim() !== TEMPLATE_V1_VERSION) {
        throw new Error("Contrato V1 incompatível com o template da campanha.");
      }
      return CAMPANHA_APROVACAO_V1;
    }
    if (input.approvalHashVersion === CAMPANHA_APROVACAO_V2) {
      return CAMPANHA_APROVACAO_V2;
    }
    throw new Error("Contrato de hash de aprovação desconhecido.");
  }
  // Sem marcador: campanha v2 é INCOMPATÍVEL com o algoritmo histórico
  // (PREFILLED não coberto) ⇒ fail-closed. Nunca tentar V1 como fallback.
  if (input.templateVersao.trim() !== TEMPLATE_V1_VERSION) {
    throw new Error("Campanha sem marcador de contrato de aprovação V2 — fail-closed.");
  }
  return CAMPANHA_APROVACAO_V1;
}

/**
 * Hash do snapshot pelo CONTRATO persistido no próprio snapshot — resolvido
 * FAIL-CLOSED (v2 sem marcador ⇒ bloqueado; NUNCA o algoritmo que der certo).
 */
export function hashDoSnapshotCampanha(snapshot: CampaignPersistSnapshot): string {
  const contrato = resolverContratoHashAprovacao({
    templateVersao: snapshot.template_versao,
    approvalHashVersion: snapshot.approval_hash_version,
  });
  return hashAprovacaoCampanha({
    contrato,
    templateVersao: snapshot.template_versao,
    templateContentHash: snapshot.template_content_hash,
    registros: snapshot.registros,
  });
}

/**
 * Base sintética de desenvolvimento da interface (contrato mínimo da
 * importação). NUNCA representa destinatários reais: domínio reservado de
 * exemplo (.test), nomes explícitamente sintéticos e identificador
 * institucional próprio — exatamente um registro por caso da jornada
 * (apto, e-mail inválido, duplicidade e e-mail divergente).
 */
export function baseSinteticaCampanha(): readonly {
  readonly profissional_id: string;
  readonly nome: string;
  readonly email_original: string;
  readonly email_normalizado: string;
  readonly status_validacao: "APTO" | "BLOQUEADO";
  readonly motivo_bloqueio: readonly string[];
}[] {
  return [
    {
      profissional_id: "PF-SINTETICO-0001",
      nome: "Ana Sintetica da Silva",
      email_original: "ana.sintetica@exemplo.test",
      email_normalizado: "ana.sintetica@exemplo.test",
      status_validacao: "APTO",
      motivo_bloqueio: [],
    },
    {
      profissional_id: "PF-SINTETICO-0002",
      nome: "Bruno Sintetico Souza",
      email_original: "bruno@@exemplo.test",
      email_normalizado: "bruno@@exemplo.test",
      status_validacao: "BLOQUEADO",
      motivo_bloqueio: ["EMAIL_INVALIDO"],
    },
    {
      profissional_id: "PF-SINTETICO-0003",
      nome: "Carla Sintetica Lima",
      email_original: "Carla.Sintetica@Exemplo.TEST",
      email_normalizado: "carla.sintetica@exemplo.test",
      status_validacao: "APTO",
      motivo_bloqueio: [],
    },
    {
      profissional_id: "PF-SINTETICO-0003",
      nome: "Carla Sintetica Lima (duplicada)",
      email_original: "carla.sintetica@exemplo.test",
      email_normalizado: "carla.sintetica@exemplo.test",
      status_validacao: "BLOQUEADO",
      motivo_bloqueio: ["IDENTIFICADOR_INSTITUCIONAL_DUPLICADO"],
    },
    {
      profissional_id: "PF-SINTETICO-0005",
      nome: "Diego Sintetico Costa",
      email_original: "diego@expanha.test",
      email_normalizado: "diego@exemplo.test",
      status_validacao: "APTO",
      motivo_bloqueio: [],
    },
  ];
}


// ---------------------------------------------------------------------------
// SLICE-02 — Fluxo operacional persistente (migration 0007). O snapshot é
// reconstruído NO SERVIDOR a partir do conteúdo re-submetido e validado;
// o hash é sempre recalculado aqui — nada disso é confiado ao navegador.
// ---------------------------------------------------------------------------

/**
 * Identificador da versão HISTÓRICA v1 — uso EXCLUSIVO de reconstrução/
 * auditoria de registros antigos (GF-2 FASE 2: v1 RETIRED). NUNCA usar como
 * default de seleção: campanha nova EXIGE seleção explícita (F5).
 */
export const CAMPAIGN_TEMPLATE_VERSAO_HISTORICA_V1 =
  "pf-atualizacao-cadastral-2026-v1" as const;

/**
 * SLICE-03C.2B1D — seleção de template por ESCOPO para campanha NOVA.
 * O cliente pode solicitar somente um identificador conhecido; o SERVIDOR é
 * a autoridade final: valida registro (registry), status e escopo e devolve
 * a versão a congelar. DRAFT/RETIRED/desconhecida/incompatível ⇒ erro
 * sanitizado ANTES de qualquer SQL (nenhum dado do request é gravado).
 * A resolução na EXECUÇÃO ignora o request e usa a versão persistida.
 */
export class CampaignTemplateSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CampaignTemplateSelectionError";
    this.code = code;
  }
}

function mensagemSelecaoTemplate(code: string): string {
  if (code === "CAMPAIGN_TEMPLATE_UNSUPPORTED") {
    return "Template desconhecido para campanha nova.";
  }
  if (code === "CAMPAIGN_TEMPLATE_NOT_APPROVED") {
    return "Template não aprovado para campanha nova.";
  }
  return "Template incompatível com o escopo da campanha.";
}

export function selecionarTemplateCampanhaNova(input: {
  readonly templateVersao: string;
}): string {
  // GF-2 F5 — versão é OBRIGATÓRIA e NUNCA tem default: ausente/vazia ⇒
  // CAMPAIGN_TEMPLATE_UNSUPPORTED (422 sanitizado na fronteira HTTP).
  const versao = input.templateVersao.trim();
  if (!versao) {
    throw new CampaignTemplateSelectionError(
      "CAMPAIGN_TEMPLATE_UNSUPPORTED",
      "Template desconhecido para campanha nova.",
    );
  }
  const resultado = selecionarTemplateNoRegistry({ templateVersion: versao });
  if (!resultado.ok) {
    throw new CampaignTemplateSelectionError(
      resultado.code,
      mensagemSelecaoTemplate(resultado.code),
    );
  }
  return resultado.templateVersion;
}

/**
 * GF-2 F4 — hash canônico do CONTEÚDO da versão (registry server-side).
 * Somente versões selecionáveis (APPROVED, escopo PF_CAMPAIGN) o expõem.
 */
export function contentHashDoTemplateSelecionado(templateVersao: string): string {
  const hash = contentHashDoTemplateNoRegistry(templateVersao);
  if (hash === undefined) {
    throw new CampaignTemplateSelectionError(
      "CAMPAIGN_TEMPLATE_UNSUPPORTED",
      "Template desconhecido para campanha nova.",
    );
  }
  return hash;
}

export interface CampaignPersistRegistro {
  readonly profissional_id: string;
  readonly nome: string;
  readonly email_normalizado: string;
  readonly status_validacao: string;
  /**
   * GF-2 FINAL (PREFILLED_CONFIRMATION) — campos de exibição do snapshot
   * (opcionais; normalizados para apresentação na ingestion). O request do
   * browser é a FONTE aqui (padrão server-reconstruction homologado); o
   * servidor confina os valores ao formato de exibição, rejeita caracteres
   * de controle e NUNCA recebe/renderiza CPF. Identidade permanece opaca:
   * profissional_id é UUID server-side, NUNCA CPF.
   */
  readonly exibicao?: {
    readonly telefone?: string;
    readonly cep?: string;
    readonly logradouro?: string;
    readonly numero?: string;
    readonly complemento?: string;
    readonly bairro?: string;
    readonly cidade?: string;
    readonly uf?: string;
  };
  /**
   * GF-2 CORRETIVO — chave opaca da FONTE (linha) emitida pelo servidor na
   * avaliação; entra na autorização V2 e no snapshot. O browser NUNCA a
   * inventa: ele ecoa o valor derivado server-side. `undefined` = fluxo sem
   * proveniência de arquivo (contratos herdados).
   */
  readonly source_record_key?: string | undefined;
}

export interface CampaignPersistDecisao {
  readonly linha: number;
  readonly profissional_id: string;
  readonly tipo: "EXCLUSAO_HUMANA" | "INCONSISTENCIA_JULGADA";
  readonly motivo: string;
}

export interface CampaignPersistInput {
  readonly fingerprintArquivo: string;
  readonly templateVersao: string;
  /** GF-2 F4 — hash canônico do conteúdo congelado no snapshot. */
  readonly templateContentHash: string;
  readonly registros: readonly CampaignPersistRegistro[];
  readonly decisoes: readonly CampaignPersistDecisao[];
}

export interface CampaignPersistSnapshot {
  readonly template_versao: string;
  /** GF-2 F4 — binding durável versão + contentHash (sem migration). */
  readonly template_content_hash: string;
  /**
   * GF-2 CORRETIVO — versão do CONTRATO do hash de aprovação, persistida no
   * JSONB (sem migration). Campanha v2 sem este marcador = V2_WITHOUT_HASH_VERSION
   * (fail-closed, nunca downgrade V2→V1).
   */
  readonly approval_hash_version: ContratoHashAprovacao;
  readonly total_registros: number;
  readonly total_aptos: number;
  readonly total_bloqueados: number;
  readonly total_aprovados: number;
  readonly registros: readonly CampaignPersistRegistro[];
  readonly decisoes_humanas: readonly CampaignPersistDecisao[];
}

/** Campos de exibição validados (PREFILLED_CONFIRMATION) de um registro. */
export interface ExibicaoRegistroCampanha {
  readonly telefone?: string;
  readonly cep?: string;
  readonly logradouro?: string;
  readonly numero?: string;
  readonly complemento?: string;
  readonly bairro?: string;
  readonly cidade?: string;
  readonly uf?: string;
}

const CHAVES_EXIBICAO = [
  "telefone",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cidade",
  "uf",
] as const;

/**
 * GF-2 FINAL — normalização + validação dos campos de exibição de UM registro
 * (fronteira do request). Whitespace sequencial → espaço único; trim; vazio ⇒
 * ausente; caractere de controle ⇒ REJEITADO (422 sanitizado). Sem semântica
 * adicional (nada é completado, convertido ou inferido — inclusive CPF, que
 * NUNCA é aceito neste contrato).
 */
export function normalizarExibicaoRegistroCampanha(
  entrada: unknown,
): ExibicaoRegistroCampanha | undefined {
  if (entrada === undefined || entrada === null) return undefined;
  if (typeof entrada !== "object" || Array.isArray(entrada)) {
    throw new CampaignTemplateSelectionError(
      "CAMPAIGN_EXIBICAO_INVALIDA",
      "Campos de exibição inválidos.",
    );
  }
  const bruto = entrada as Record<string, unknown>;
  const saida: Record<string, string> = {};
  for (const chave of CHAVES_EXIBICAO) {
    const valor = bruto[chave];
    if (valor === undefined || valor === null) continue;
    if (typeof valor !== "string") {
      throw new CampaignTemplateSelectionError(
        "CAMPAIGN_EXIBICAO_INVALIDA",
        `Campo de exibição inválido: ${chave}.`,
      );
    }
    const normalizado = valor.replace(/\s+/g, " ").trim();
    if (normalizado === "") continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(normalizado)) {
      throw new CampaignTemplateSelectionError(
        "CAMPAIGN_EXIBICAO_INVALIDA",
        `Campo de exibição contém caractere de controle: ${chave}.`,
      );
    }
    saida[chave] = normalizado;
  }
  const chaves = Object.keys(saida);
  if (chaves.length === 0) return undefined;
  return chaves.length === CHAVES_EXIBICAO.length
    ? (saida as ExibicaoRegistroCampanha)
    : (Object.fromEntries(chaves.map((c) => [c, saida[c] as string])) as ExibicaoRegistroCampanha);
}

/**
 * Snapshot determinístico do conteúdo aprovado. `registros` contém APENAS os
 * aptos (o aprovado); e-mails permanecem normalizados (sem valor bruto) e
 * nenhuma credencial ou PII sensível entra no snapshot.
 */
export function snapshotCampanha(input: CampaignPersistInput): CampaignPersistSnapshot {
  const registrosAptos = input.registros.filter(
    (registro) => registro.status_validacao === "APTO",
  );
  return {
    template_versao: input.templateVersao,
    template_content_hash: input.templateContentHash,
    // GF-2 CORRETIVO — campanha NOVA usa SEMPRE o contrato V2 (versão
    // explícita no snapshot JSONB; sem migration, sem backfill histórico).
    approval_hash_version: CAMPANHA_APROVACAO_V2,
    total_registros: input.registros.length,
    total_aptos: registrosAptos.length,
    total_bloqueados: input.registros.length - registrosAptos.length,
    // GF-3 CORRECTIVE-01 (F4) — o contrato cliente/servidor envia
    // `registros` = finais APTO após as exclusões humanas e `decisoes` =
    // trilha de auditoria dessas decisões. As decisões NÃO são subtraídas
    // novamente: total_aprovados = número de registros efetivamente
    // aprovados persistidos (snapshot.registros). Conjunto de destinatários,
    // exclusões e semântica de decisão intocados.
    total_aprovados: registrosAptos.length,
    registros: registrosAptos.map((registro) => ({
      profissional_id: registro.profissional_id,
      nome: registro.nome,
      email_normalizado: registro.email_normalizado,
      status_validacao: registro.status_validacao,
      ...(registro.source_record_key === undefined
        ? {}
        : { source_record_key: registro.source_record_key }),
      ...(registro.exibicao === undefined ? {} : { exibicao: registro.exibicao }),
    })),
    decisoes_humanas: input.decisoes,
  };
}

/** Código operacional do lote controlado da campanha (determinístico). */
export function codigoLoteCampanha(fingerprintArquivo: string): string {
  return `CAMPANHA_PF_${fingerprintArquivo.slice(0, 12).toUpperCase()}`;
}
