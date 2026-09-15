import { ORIGENS, type Origem } from "@integra-correios/domain";

export const AREAS_COCKPIT = [
  { id: "entrada", rotulo: "Entrada" },
  { id: "validacao", rotulo: "Validação" },
  { id: "lotes", rotulo: "Lotes" },
  { id: "retornos", rotulo: "Retornos" },
  { id: "gestao", rotulo: "Gestão" },
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
