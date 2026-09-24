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
