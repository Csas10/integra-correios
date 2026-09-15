import { ORIGENS, type Origem } from "@integra-correios/domain";

export const AREAS_COCKPIT = [
  {
    id: "entrada",
    rotulo: "Entrada",
    titulo: "Documentos chegando",
    descricao: "Receba arquivos PF, PJ e retornos dos Correios com a origem preservada.",
    acao: "Receber documentos",
  },
  {
    id: "validacao",
    rotulo: "Validação",
    titulo: "Organizar e validar",
    descricao: "Normalize documentos, CEPs e duplicidades antes de preparar qualquer envio.",
    acao: "Abrir validação",
  },
  {
    id: "lotes",
    rotulo: "Lotes",
    titulo: "Preparar envios",
    descricao: "Monte lotes segregados por origem e gere evidências com SHA-256.",
    acao: "Preparar lote",
  },
  {
    id: "retornos",
    rotulo: "Retornos",
    titulo: "Reconciliar retornos",
    descricao: "Associe confirmações e rejeições sem perder a identidade do item enviado.",
    acao: "Importar retorno",
  },
  {
    id: "gestao",
    rotulo: "Gestão",
    titulo: "Auditar a operação",
    descricao: "Acompanhe gates, histórico e integridade documental por PF ou PJ.",
    acao: "Abrir auditoria",
  },
] as const;

export type AreaCockpit = (typeof AREAS_COCKPIT)[number]["id"];

export interface FiltroOrigem {
  readonly valor: "TODOS" | Origem;
  readonly rotulo: string;
}

export const FILTROS_ORIGEM: readonly FiltroOrigem[] = [
  { valor: "TODOS", rotulo: "Todos" },
  ...ORIGENS.map((origem) => ({
    valor: origem,
    rotulo: origem === "PF" ? "Profissionais" : "Empresas",
  })),
];

export type ValorFiltroOrigem = FiltroOrigem["valor"];

export const INDICADORES = [
  { rotulo: "Recebidos", detalhe: "Documentos na fonte autorizada" },
  { rotulo: "Prontos", detalhe: "Registros aptos para a próxima etapa" },
  { rotulo: "Pendências", detalhe: "Itens que exigem tratamento" },
  { rotulo: "Em lote", detalhe: "Itens reservados para envio" },
] as const;

export function obterArea(id: AreaCockpit) {
  return AREAS_COCKPIT.find((area) => area.id === id) ?? AREAS_COCKPIT[0];
}
