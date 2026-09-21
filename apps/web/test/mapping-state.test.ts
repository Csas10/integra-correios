import { describe, expect, it } from "vitest";
import { atualizarSelecaoMapeamento } from "../src/mapping-state.js";

describe("mapping-state da UI", () => {
  it("opção vazia remove o campo em vez de convertê-lo para coluna 0", () => {
    const inicial = { CODIGO: 0, ORIGEM: 5 };
    expect(atualizarSelecaoMapeamento(inicial, "ORIGEM", "")).toEqual({ CODIGO: 0 });
  });

  it("seleção numérica preserva o índice da coluna", () => {
    expect(atualizarSelecaoMapeamento({ CODIGO: 0 }, "NOME", "3")).toEqual({
      CODIGO: 0,
      NOME: 3,
    });
  });
});
