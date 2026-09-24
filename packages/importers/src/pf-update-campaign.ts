import type { FolhaExtraida, LinhaDados } from "./safe-read.js";

export const PF_UPDATE_VALIDATION_STATUSES = [
  "APTO",
  "BLOQUEADO",
  "EXCLUIDO_DO_LOTE",
] as const;

export type PfUpdateValidationStatus = (typeof PF_UPDATE_VALIDATION_STATUSES)[number];

export type PfUpdateBlockReason =
  | "IDENTIFICADOR_INSTITUCIONAL_AUSENTE"
  | "IDENTIFICADOR_INSTITUCIONAL_DUPLICADO"
  | "NOME_AUSENTE"
  | "EMAIL_AUSENTE"
  | "EMAIL_INVALIDO"
  | "EMAIL_DUPLICADO";

export interface PfUpdateCampaignRow {
  readonly linha: number;
  readonly profissional_id: string;
  readonly nome: string;
  readonly nome_exibicao: string;
  readonly email: string;
  readonly email_normalizado: string;
  readonly status_validacao: PfUpdateValidationStatus;
  readonly motivo_bloqueio: readonly PfUpdateBlockReason[];
  readonly normalizacoes_aplicadas: readonly ("NOME_ESPACOS" | "EMAIL_ESPACOS" | "EMAIL_CASE")[];
}

export interface PfUpdateDuplicateGroup {
  readonly email_normalizado: string;
  readonly linhas: readonly number[];
  readonly profissionais: readonly string[];
}

export interface PfUpdateCampaignReport {
  readonly sha256: string;
  readonly total_registros: number;
  readonly aptos: number;
  readonly bloqueados: number;
  readonly excluidos_do_lote: number;
  readonly normalizacoes_nome: number;
  readonly normalizacoes_email: number;
  readonly duplicidades_email: readonly PfUpdateDuplicateGroup[];
  readonly registros: readonly PfUpdateCampaignRow[];
}

export interface PfUpdateCampaignOptions {
  readonly colunaIdentificadorInstitucional: string;
}

export class PfUpdateCampaignImportError extends Error {
  constructor(readonly codigo: string, message: string) {
    super(message);
    this.name = "PfUpdateCampaignImportError";
  }
}

function canonizarCabecalho(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function normalizarNomeCampanha(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizarEmailCampanha(value: string): string {
  return value.trim().toLowerCase();
}

export function emailCampanhaValido(value: string): boolean {
  if (value.length < 3 || value.length > 254) return false;
  const match = /^([^\s@]+)@([^\s@]+)$/.exec(value);
  if (!match) return false;
  const [, local, domain] = match;
  if (!local || !domain || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) {
    return false;
  }
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    /^[A-Za-z0-9.-]+$/.test(domain);
}

function valorNaLinha(linha: LinhaDados, indice: number): string {
  return linha.celulas[indice]?.texto ?? "";
}

function indiceCabecalho(folha: FolhaExtraida, canonical: string): number {
  return folha.cabecalhos.findIndex((cabecalho) => canonizarCabecalho(cabecalho) === canonical);
}

function adicionarMotivo(motivos: PfUpdateBlockReason[], motivo: PfUpdateBlockReason): void {
  if (!motivos.includes(motivo)) motivos.push(motivo);
}

export function analisarCampanhaAtualizacaoPf(
  leitura: { readonly sha256: string; readonly folha: FolhaExtraida },
  opcoes: PfUpdateCampaignOptions,
): PfUpdateCampaignReport {
  const idxNome = indiceCabecalho(leitura.folha, "NOME");
  const idxEmail = indiceCabecalho(leitura.folha, "EMAIL");
  const idCanonical = canonizarCabecalho(opcoes.colunaIdentificadorInstitucional);
  const idxId = indiceCabecalho(leitura.folha, idCanonical);

  if (idxNome < 0) {
    throw new PfUpdateCampaignImportError("NOME_COLUMN_MISSING", "Coluna NOME não encontrada.");
  }
  if (idxEmail < 0) {
    throw new PfUpdateCampaignImportError(
      "EMAIL_COLUMN_MISSING",
      "Coluna E-MAIL/E- MAIL não encontrada.",
    );
  }
  if (!idCanonical || idxId < 0) {
    throw new PfUpdateCampaignImportError(
      "INSTITUTIONAL_ID_COLUMN_MISSING",
      "Identificador institucional é obrigatório antes de qualquer lote.",
    );
  }
  if (idxId === idxNome || idxId === idxEmail) {
    throw new PfUpdateCampaignImportError(
      "INSTITUTIONAL_ID_COLUMN_INVALID",
      "Nome ou e-mail não podem ser usados como identificador institucional.",
    );
  }

  const provisoria = leitura.folha.linhas
    .map((linha) => {
      const profissionalId = normalizarNomeCampanha(valorNaLinha(linha, idxId));
      const nomeOriginal = valorNaLinha(linha, idxNome);
      const emailOriginal = valorNaLinha(linha, idxEmail);
      const nome = normalizarNomeCampanha(nomeOriginal);
      const emailNormalizado = normalizarEmailCampanha(emailOriginal);
      if (!profissionalId && !nome && !emailNormalizado) return undefined;

      const motivos: PfUpdateBlockReason[] = [];
      const normalizacoes: ("NOME_ESPACOS" | "EMAIL_ESPACOS" | "EMAIL_CASE")[] = [];

      if (!profissionalId) adicionarMotivo(motivos, "IDENTIFICADOR_INSTITUCIONAL_AUSENTE");
      if (!nome) adicionarMotivo(motivos, "NOME_AUSENTE");
      if (!emailNormalizado) {
        adicionarMotivo(motivos, "EMAIL_AUSENTE");
      } else if (!emailCampanhaValido(emailNormalizado)) {
        adicionarMotivo(motivos, "EMAIL_INVALIDO");
      }

      if (nomeOriginal !== nome) normalizacoes.push("NOME_ESPACOS");
      const emailSemEspacos = emailOriginal.trim();
      if (emailSemEspacos !== emailOriginal) normalizacoes.push("EMAIL_ESPACOS");
      if (emailSemEspacos && emailSemEspacos !== emailNormalizado) normalizacoes.push("EMAIL_CASE");

      return {
        linha: linha.numero,
        profissional_id: profissionalId,
        nome,
        nome_exibicao: nome,
        email: emailOriginal,
        email_normalizado: emailNormalizado,
        motivos,
        normalizacoes,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  const porEmail = new Map<string, typeof provisoria>();
  const porId = new Map<string, typeof provisoria>();
  for (const row of provisoria) {
    if (row.email_normalizado) {
      const grupo = porEmail.get(row.email_normalizado) ?? [];
      grupo.push(row);
      porEmail.set(row.email_normalizado, grupo);
    }
    if (row.profissional_id) {
      const grupo = porId.get(row.profissional_id) ?? [];
      grupo.push(row);
      porId.set(row.profissional_id, grupo);
    }
  }

  for (const grupo of porEmail.values()) {
    if (grupo.length > 1) {
      for (const row of grupo) adicionarMotivo(row.motivos, "EMAIL_DUPLICADO");
    }
  }
  for (const grupo of porId.values()) {
    if (grupo.length > 1) {
      for (const row of grupo) adicionarMotivo(row.motivos, "IDENTIFICADOR_INSTITUCIONAL_DUPLICADO");
    }
  }

  const registros: PfUpdateCampaignRow[] = provisoria.map((row) => ({
    linha: row.linha,
    profissional_id: row.profissional_id,
    nome: row.nome,
    nome_exibicao: row.nome_exibicao,
    email: row.email,
    email_normalizado: row.email_normalizado,
    status_validacao: row.motivos.length === 0 ? "APTO" : "BLOQUEADO",
    motivo_bloqueio: row.motivos,
    normalizacoes_aplicadas: row.normalizacoes,
  }));

  const duplicidadesEmail: PfUpdateDuplicateGroup[] = [...porEmail.entries()]
    .filter(([, grupo]) => grupo.length > 1)
    .map(([email, grupo]) => ({
      email_normalizado: email,
      linhas: grupo.map((row) => row.linha),
      profissionais: grupo.map((row) => row.profissional_id),
    }));

  return {
    sha256: leitura.sha256,
    total_registros: registros.length,
    aptos: registros.filter((row) => row.status_validacao === "APTO").length,
    bloqueados: registros.filter((row) => row.status_validacao === "BLOQUEADO").length,
    excluidos_do_lote: registros.filter((row) => row.status_validacao === "EXCLUIDO_DO_LOTE").length,
    normalizacoes_nome: registros.filter((row) =>
      row.normalizacoes_aplicadas.includes("NOME_ESPACOS"),
    ).length,
    normalizacoes_email: registros.filter((row) =>
      row.normalizacoes_aplicadas.some((item) => item.startsWith("EMAIL_")),
    ).length,
    duplicidades_email: duplicidadesEmail,
    registros,
  };
}
