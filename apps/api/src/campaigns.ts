import { createHash } from "node:crypto";

export const PF_UPDATE_CAMPAIGN_CODE_PREFIX =
  "PF_ATUALIZACAO_CADASTRAL_" as const;
export const RESERVED_PILOT_BATCH_CODE = "CONTROLLED_GMAIL_TEST" as const;

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

export interface PfUpdateCampaignPolicy {
  readonly enabled: boolean;
  readonly phase: "FOUNDATION";
  readonly individualOperatorIdentityRequired: true;
  readonly canPersistImport: false;
  readonly canCreateBatch: false;
  readonly canExecute: false;
  readonly realSendEnabled: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function carregarPoliticaCampanhaAtualizacao(
  env: Environment = process.env,
): PfUpdateCampaignPolicy {
  return {
    enabled: env.PF_CAMPAIGN_ENABLED === "true",
    phase: "FOUNDATION",
    individualOperatorIdentityRequired: true,
    canPersistImport: false,
    canCreateBatch: false,
    canExecute: false,
    realSendEnabled: env.REAL_SEND_ENABLED === "true",
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
 * Hash de aprovação (SHA-256) sobre o conteúdo congelado da campanha:
 * versão do template + registros normalizados. Qualquer alteração posterior
 * de destinatário, template ou conteúdo produz hash divergente e invalida a
 * aprovação — a validade é sempre função pura do hash.
 */
export function hashAprovacaoCampanha(input: {
  readonly templateVersao: string;
  readonly registros: readonly {
    readonly profissional_id: string;
    readonly nome: string;
    readonly email_normalizado: string;
    readonly status_validacao: string;
  }[];
}): string {
  const sha256 = createHash("sha256");
  sha256.update(`template:${input.templateVersao}\n`);
  for (const registro of input.registros) {
    sha256.update(
      `${registro.profissional_id}\u001f${registro.nome}\u001f` +
        `${registro.email_normalizado}\u001f${registro.status_validacao}\n`,
    );
  }
  return sha256.digest("hex");
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
