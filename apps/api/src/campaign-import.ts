import {
  analisarCampanhaAtualizacaoPf,
  emailCampanhaValido,
  normalizarEmailCampanha,
  normalizarNomeCampanha,
  LeituraSeguraError,
  lerXlsx,
  normalizarCabecalho,
  PfUpdateCampaignImportError,
  type FolhaExtraida,
  type PfUpdateBlockReason,
  type PfUpdateCampaignReport,
  type PfUpdateDuplicateGroup,
  type PfUpdateValidationStatus,
} from "@integra-correios/importers";

/**
 * Avaliação da base institucional da Campanha PF (etapas 3–5 da
 * /operacao/email): reutiliza a leitura segura existente (bloqueio de macros,
 * erro de fórmula e limites estruturais) e o importador canônico, exige
 * identificador institucional e NUNCA assume colunas. A classificação final é
 * sempre recalculada no servidor — o arquivo original NUNCA é mutado e nada é
 * persistido nesta fase (canPersistImport=false).
 */

/** Contrato mínimo de campos do mapeamento de colunas. */
export const CAMPOS_MAPEAMENTO_CAMPANHA = [
  "profissional_id",
  "nome",
  "nome_exibicao",
  "email_original",
  "email_normalizado",
  "status_validacao",
  "motivo_bloqueio",
] as const;

export type CampoMapeamentoCampanha = (typeof CAMPOS_MAPEAMENTO_CAMPANHA)[number];

/** Códigos de inconsistência exigindo decisão humana (papel REVISOR). */
export const CODIGOS_INCONSISTENCIA_CAMPANHA = [
  "EMAIL_NORMALIZACAO",
  "EMAIL_NORMALIZADO_DIVERGENTE",
  "EMAIL_DUPLICADO",
  "IDENTIFICADOR_INSTITUCIONAL_DUPLICADO",
] as const;

export type CodigoInconsistenciaCampanha =
  (typeof CODIGOS_INCONSISTENCIA_CAMPANHA)[number];

export interface RegistroAvaliado {
  readonly linha: number;
  readonly profissional_id: string;
  readonly nome: string;
  readonly nome_exibicao: string;
  readonly email_original: string;
  readonly email_normalizado: string;
  readonly status_validacao: PfUpdateValidationStatus;
  readonly motivo_bloqueio: readonly PfUpdateBlockReason[];
  readonly normalizacoes_aplicadas: readonly ("NOME_ESPACOS" | "EMAIL_ESPACOS" | "EMAIL_CASE")[];
  readonly inconsistencias: readonly CodigoInconsistenciaCampanha[];
}

export interface AvaliacaoBase {
  readonly sha256: string;
  readonly total_registros: number;
  readonly aptos: number;
  readonly bloqueados: number;
  /** Linhas com ao menos uma inconsistência aguardando decisão humana. */
  readonly inconsistencias_pendentes: number;
  readonly duplicidades_email: readonly PfUpdateDuplicateGroup[];
  readonly registros: readonly RegistroAvaliado[];
}

/** Estrutura exibida nas etapas 3–4 da jornada (antes de confirmar colunas). */
export interface AvaliacaoArquivo {
  readonly sha256: string;
  readonly folhas_disponiveis: readonly string[];
  readonly cabecalhos: readonly string[];
  readonly total_linhas: number;
  readonly mapeamento_sugerido: Readonly<Record<CampoMapeamentoCampanha, number>>;
  readonly campos_obrigatorios: readonly CampoMapeamentoCampanha[];
}

export class AvaliacaoInvalidaError extends Error {
  constructor(
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "AvaliacaoInvalidaError";
  }
}

const CAMPOS_OBRIGATORIOS: readonly CampoMapeamentoCampanha[] = [
  "profissional_id",
  "nome",
  "email_original",
];

export function camposObrigatoriosMapeamento(): readonly CampoMapeamentoCampanha[] {
  return CAMPOS_OBRIGATORIOS;
}

/**
 * Sugestão de mapeamento por cabeçalho canônico (mesma normalização do
 * importador): profissional_id ← MATRICULA | IDENTIFICACAO; nome ← NOME |
 * NOMECOMPLETO; email ← EMAIL. Campos derivados permanecem sem coluna (-1).
 * A UI exibe a sugestão e o operador confirma campo a campo.
 */
export function sugerirMapeamento(folha: FolhaExtraida): Record<CampoMapeamentoCampanha, number> {
  const indicePorCanonico = new Map<string, number>();
  folha.cabecalhos.forEach((cabecalho, indice) => {
    const canonico = normalizarCabecalho(cabecalho).replace(/[^A-Z0-9]/g, "");
    if (canonico && !indicePorCanonico.has(canonico)) indicePorCanonico.set(canonico, indice);
  });
  function primeiro(canonicos: readonly string[]): number {
    for (const canonico of canonicos) {
      const indice = indicePorCanonico.get(canonico);
      if (indice !== undefined) return indice;
    }
    return -1;
  }
  return {
    profissional_id: primeiro(["MATRICULA", "IDENTIFICACAO", "IDINSTITUCIONAL"]),
    nome: primeiro(["NOME", "NOMECOMPLETO"]),
    nome_exibicao: -1,
    email_original: primeiro(["EMAIL", "EMAILINSTITUCIONAL"]),
    email_normalizado: -1,
    status_validacao: -1,
    motivo_bloqueio: -1,
  };
}

/**
 * Valida o mapeamento campo→coluna de origem: campos conhecidos, todos os
 * obrigatórios presentes e cada coluna de origem usada por no máximo um campo.
 */
export function validarMapeamentoCampanha(
  mapeamento: Readonly<Record<string, number>>,
): void {
  const campos = Object.keys(mapeamento);
  for (const campo of campos) {
    if (!CAMPOS_MAPEAMENTO_CAMPANHA.includes(campo as CampoMapeamentoCampanha)) {
      throw new AvaliacaoInvalidaError("CAMPO_DESCONHECIDO", `Campo fora do contrato: ${campo}.`);
    }
    const coluna = mapeamento[campo] as unknown;
    if (typeof coluna !== "number" || !Number.isInteger(coluna) || coluna < 0) {
      throw new AvaliacaoInvalidaError("COLUNA_INVALIDA", `Coluna inválida para ${campo}.`);
    }
  }
  const ausentes = CAMPOS_OBRIGATORIOS.filter(
    (campo) => !(typeof mapeamento[campo] === "number" && (mapeamento[campo] as number) >= 0),
  );
  if (ausentes.length > 0) {
    throw new AvaliacaoInvalidaError(
      "MAPEAMENTO_INCOMPLETO",
      `Mapeamento incompleto: ${ausentes.join(", ")}.`,
    );
  }
  const colunasVistas = new Set<number>();
  for (const campo of campos) {
    const coluna = mapeamento[campo] as number;
    if (colunasVistas.has(coluna)) {
      throw new AvaliacaoInvalidaError(
        "COLUNA_DUPLICADA",
        "Cada coluna origina no máximo um campo.",
      );
    }
    colunasVistas.add(coluna);
  }
}

/**
 * Inconsistências de UMA linha já classificada: divergência recuperável de
 * caixa/espaços com destino válido (EMAIL_NORMALIZACAO) e duplicidades que
 * exigem decisão humana. Regra pura, reutilizada por ambos os caminhos.
 */
function inconsistenciasDaLinha(linha: {
  readonly email_original: string;
  readonly email_normalizado: string;
  readonly motivo_bloqueio: readonly string[];
}): CodigoInconsistenciaCampanha[] {
  const inconsistencias: CodigoInconsistenciaCampanha[] = [];
  const emailSemEspacos = linha.email_original.trim();
  if (
    linha.email_normalizado &&
    emailSemEspacos &&
    emailSemEspacos !== linha.email_normalizado &&
    emailCampanhaValido(emailSemEspacos)
  ) {
    // Whitespace interno permanece no normalizado e vira EMAIL_INVALIDO
    // (corretivo da segunda revisão integral); divergência de caixa com
    // destino válido é decisão humana (EMAIL_NORMALIZACAO).
    inconsistencias.push("EMAIL_NORMALIZACAO");
  }
  if (linha.motivo_bloqueio.includes("EMAIL_DUPLICADO")) inconsistencias.push("EMAIL_DUPLICADO");
  if (linha.motivo_bloqueio.includes("IDENTIFICADOR_INSTITUCIONAL_DUPLICADO")) {
    inconsistencias.push("IDENTIFICADOR_INSTITUCIONAL_DUPLICADO");
  }
  return inconsistencias;
}

function totalInconsistenciasPendentes(registros: readonly RegistroAvaliado[]): number {
  return registros.filter((registro) => registro.inconsistencias.length > 0).length;
}

/**
 * Reclassificação completa sobre a folha ORIGINAL usando o mapeamento
 * confirmado (campo→coluna de origem). MESMAS regras do importador
 * (identificador institucional, normalizações, duplicidades por e-mail e por
 * identificador). email_normalizado é SEMPRE derivado no servidor; se a
 * planilha trouxer um valor informado divergente do derivado, a divergência
 * é registrada como inconsistência humana — nunca silenciada.
 */
export function reaplicarClassificacao(
  folha: FolhaExtraida,
  mapeamento: Readonly<Record<string, number>>,
): Omit<AvaliacaoBase, "sha256"> {
  validarMapeamentoCampanha(mapeamento);
  const idxId = mapeamento.profissional_id as number;
  const idxNome = mapeamento.nome as number;
  const idxEmail = mapeamento.email_original as number;
  const idxNormalizado = mapeamento.email_normalizado as number | undefined;

  const provisoria = folha.linhas
    .map((linha) => {
      const valor = (indice: number): string => linha.celulas[indice]?.texto ?? "";
      const profissionalId = normalizarNomeCampanha(valor(idxId));
      const nomeOriginal = valor(idxNome);
      const emailOriginal = valor(idxEmail);
      const nome = normalizarNomeCampanha(nomeOriginal);
      const emailNormalizado = normalizarEmailCampanha(emailOriginal);
      if (!profissionalId && !nome && !emailNormalizado) return undefined;

      const motivos: PfUpdateBlockReason[] = [];
      const normalizacoes: ("NOME_ESPACOS" | "EMAIL_ESPACOS" | "EMAIL_CASE")[] = [];
      if (!profissionalId) motivos.push("IDENTIFICADOR_INSTITUCIONAL_AUSENTE");
      if (!nome) motivos.push("NOME_AUSENTE");
      if (!emailNormalizado) {
        motivos.push("EMAIL_AUSENTE");
      } else if (!emailCampanhaValido(emailNormalizado)) {
        motivos.push("EMAIL_INVALIDO");
      }
      if (nomeOriginal !== nome) normalizacoes.push("NOME_ESPACOS");
      const emailSemEspacos = emailOriginal.trim();
      if (emailSemEspacos !== emailOriginal) normalizacoes.push("EMAIL_ESPACOS");
      if (emailSemEspacos && emailSemEspacos !== emailNormalizado) normalizacoes.push("EMAIL_CASE");

      return {
        linha: linha.numero,
        profissionalId,
        nome,
        emailOriginal,
        emailNormalizado,
        motivos,
        normalizacoes,
        divergenteInformado: false as boolean,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  const porEmail = new Map<string, typeof provisoria>();
  const porId = new Map<string, typeof provisoria>();
  for (const row of provisoria) {
    if (row.emailNormalizado) {
      const grupo = porEmail.get(row.emailNormalizado) ?? [];
      grupo.push(row);
      porEmail.set(row.emailNormalizado, grupo);
    }
    if (row.profissionalId) {
      const grupo = porId.get(row.profissionalId) ?? [];
      grupo.push(row);
      porId.set(row.profissionalId, grupo);
    }
  }
  for (const grupo of porEmail.values()) {
    if (grupo.length > 1) for (const row of grupo) row.motivos.push("EMAIL_DUPLICADO");
  }
  for (const grupo of porId.values()) {
    if (grupo.length > 1) {
      for (const row of grupo) row.motivos.push("IDENTIFICADOR_INSTITUCIONAL_DUPLICADO");
    }
  }

  const registros: RegistroAvaliado[] = provisoria.map((row) => {
    let divergenteInformado = row.divergenteInformado;
    if (idxNormalizado !== undefined) {
      const informado = normalizarEmailCampanha(
        folha.linhas.find((linha) => linha.numero === row.linha)?.celulas[idxNormalizado]?.texto ?? "",
      );
      if (informado && informado !== row.emailNormalizado) divergenteInformado = true;
    }
    const inconsistencias = inconsistenciasDaLinha({
      email_original: row.emailOriginal,
      email_normalizado: row.emailNormalizado,
      motivo_bloqueio: row.motivos,
    });
    if (divergenteInformado) inconsistencias.push("EMAIL_NORMALIZADO_DIVERGENTE");
    return {
      linha: row.linha,
      profissional_id: row.profissionalId,
      nome: row.nome,
      nome_exibicao: row.nome,
      email_original: row.emailOriginal,
      email_normalizado: row.emailNormalizado,
      status_validacao: row.motivos.length === 0 ? "APTO" : "BLOQUEADO",
      motivo_bloqueio: [...new Set(row.motivos)],
      normalizacoes_aplicadas: row.normalizacoes,
      inconsistencias,
    };
  });

  const duplicidadesEmail: PfUpdateDuplicateGroup[] = [...porEmail.entries()]
    .filter(([, grupo]) => grupo.length > 1)
    .map(([email, grupo]) => ({
      email_normalizado: email,
      linhas: grupo.map((row) => row.linha),
      profissionais: grupo.map((row) => row.profissionalId),
    }));

  return {
    total_registros: registros.length,
    aptos: registros.filter((row) => row.status_validacao === "APTO").length,
    bloqueados: registros.filter((row) => row.status_validacao === "BLOQUEADO").length,
    inconsistencias_pendentes: totalInconsistenciasPendentes(registros),
    duplicidades_email: duplicidadesEmail,
    registros,
  };
}

/** Adapta o relatório do importador canônico (cabeçalhos NOME/E-MAIL/MATRICULA). */
function converterRelatorioImportador(
  relatorio: PfUpdateCampaignReport,
): Omit<AvaliacaoBase, "sha256"> {
  const registros: RegistroAvaliado[] = relatorio.registros.map((row) => ({
    linha: row.linha,
    profissional_id: row.profissional_id,
    nome: row.nome,
    nome_exibicao: row.nome_exibicao,
    email_original: row.email,
    email_normalizado: row.email_normalizado,
    status_validacao: row.status_validacao,
    motivo_bloqueio: row.motivo_bloqueio,
    normalizacoes_aplicadas: row.normalizacoes_aplicadas,
    inconsistencias: inconsistenciasDaLinha({
      email_original: row.email,
      email_normalizado: row.email_normalizado,
      motivo_bloqueio: row.motivo_bloqueio,
    }),
  }));
  return {
    total_registros: relatorio.total_registros,
    aptos: relatorio.aptos,
    bloqueados: relatorio.bloqueados,
    inconsistencias_pendentes: totalInconsistenciasPendentes(registros),
    duplicidades_email: relatorio.duplicidades_email,
    registros,
  };
}

/**
 * Etapa 3 (Importação): avalia o arquivo SEM assumir colunas — devolve
 * cabeçalhos, folhas e sugestão de mapeamento. Nada é persistido.
 */
export function avaliarArquivoCampanha(nomeArquivo: string, bytes: Uint8Array): AvaliacaoArquivo {
  const leitura = lerXlsx({ nome: nomeArquivo, bytes });
  return {
    sha256: leitura.sha256,
    folhas_disponiveis: leitura.folhasDisponiveis,
    cabecalhos: leitura.folha.cabecalhos,
    total_linhas: leitura.folha.linhas.length,
    mapeamento_sugerido: sugerirMapeamento(leitura.folha),
    campos_obrigatorios: CAMPOS_OBRIGATORIOS,
  };
}

/**
 * Etapas 4–5 (Mapeamento → Inconsistências): aplica o mapeamento confirmado,
 * recalcula TODA a classificação no servidor e devolve a base avaliada.
 * Sem mapeamento explícito, usa o importador canônico por cabeçalho canônico
 * (NOME / E-MAIL / MATRICULA). LeituraSeguraError, AvaliacaoInvalidaError e
 * PfUpdateCampaignImportError propagam para mapeamento 4xx na rota.
 */
export function avaliarBaseCampanha(
  nomeArquivo: string,
  bytes: Uint8Array,
  opcoes: { mapeamento?: Readonly<Record<string, number>> } = {},
): AvaliacaoBase {
  const leitura = lerXlsx({ nome: nomeArquivo, bytes });
  if (opcoes.mapeamento) {
    return { sha256: leitura.sha256, ...reaplicarClassificacao(leitura.folha, opcoes.mapeamento) };
  }
  const analise = analisarCampanhaAtualizacaoPf(leitura, {
    colunaIdentificadorInstitucional: "MATRICULA",
  });
  return { sha256: leitura.sha256, ...converterRelatorioImportador(analise) };
}

export { LeituraSeguraError, PfUpdateCampaignImportError };
