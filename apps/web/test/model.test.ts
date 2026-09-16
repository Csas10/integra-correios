import { describe, expect, it } from "vitest";
import { AREAS_COCKPIT, FILTROS_ORIGEM, INDICADORES, obterArea } from "../src/model";

describe("modelo do cockpit web", () => {
  it("mantém as cinco áreas na ordem operacional", () => {
    expect(AREAS_COCKPIT.map((area) => area.id)).toEqual([
      "entrada",
      "validacao",
      "lotes",
      "retornos",
      "gestao",
    ]);
  });

  it("segrega os filtros PF e PJ sem criar uma terceira origem", () => {
    expect(FILTROS_ORIGEM.map((filtro) => filtro.valor)).toEqual(["TODOS", "PF", "PJ"]);
  });

  it("define indicadores estruturais sem contagens amostrais", () => {
    expect(INDICADORES).toHaveLength(4);
    expect(INDICADORES.every((indicador) => !("valor" in indicador))).toBe(true);
  });

  it("resolve a configuração da área selecionada", () => {
    expect(obterArea("retornos").titulo).toBe("Reconciliar retornos");
  });
});
