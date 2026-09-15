import { describe, expect, it } from "vitest";
import {
  OBJETO_REGISTRADO_HEADERS,
  OBJETO_SIMPLES_HEADERS,
  TEMPLATE_DESTINATARIOS_HEADERS,
  TEMPLATE_REMETENTES_HEADERS,
  validarTemplateOficial,
} from "../src/index.js";

describe("contratos dos templates oficiais", () => {
  it("mantém as quantidades de colunas auditadas", () => {
    expect(TEMPLATE_REMETENTES_HEADERS).toHaveLength(15);
    expect(TEMPLATE_DESTINATARIOS_HEADERS).toHaveLength(15);
    expect(OBJETO_SIMPLES_HEADERS).toHaveLength(34);
    expect(OBJETO_REGISTRADO_HEADERS).toHaveLength(87);
  });

  it("aceita a estrutura oficial sem depender de linhas de dados", () => {
    expect(validarTemplateOficial("OBJETO_REGISTRADO", OBJETO_REGISTRADO_HEADERS)).toEqual({
      valid: true,
      missing: [],
      duplicated: [],
    });
  });

  it("bloqueia contrato incompleto", () => {
    const incomplete = OBJETO_SIMPLES_HEADERS.slice(0, -1);
    const result = validarTemplateOficial("OBJETO_SIMPLES", incomplete);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["dataPrevistaPostagem"]);
  });
});
