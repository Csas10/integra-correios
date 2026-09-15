import { describe, expect, it } from "vitest";
import {
  criarIdentidade,
  criarLoteId,
  decomporIdentidade,
  reconciliarContagens,
  TransicaoInvalidaError,
  validarItensDoLote,
  validarTransicao,
  type Lote,
} from "../src/index.js";

describe("identidade PF/PJ", () => {
  it("compõe e decompõe a origem sem perder o código", () => {
    const identidade = criarIdentidade("PF", "000001");
    expect(identidade).toBe("PF|000001");
    expect(decomporIdentidade(identidade)).toEqual({ origem: "PF", codigo: "000001" });
  });

  it("bloqueia código vazio ou com separador reservado", () => {
    expect(() => criarIdentidade("PJ", " ")).toThrow("Código operacional inválido");
    expect(() => criarIdentidade("PJ", "A|B")).toThrow("Código operacional inválido");
  });
});

describe("workflow segregado", () => {
  it("obriga PF a passar pelo contato e confirmação", () => {
    expect(() => validarTransicao("PF", "RECEBIDO", "EM_VALIDACAO")).toThrow(
      TransicaoInvalidaError,
    );
    expect(() => validarTransicao("PF", "RECEBIDO", "APTO_CONTATO")).not.toThrow();
  });

  it("permite PJ seguir da entrada para validação", () => {
    expect(() => validarTransicao("PJ", "RECEBIDO", "EM_VALIDACAO")).not.toThrow();
  });
});

describe("lotes", () => {
  it("gera identificador determinístico por origem", () => {
    expect(criarLoteId("PF", 3)).toBe("PF-LOTE003");
    expect(criarLoteId("PJ", 8)).toBe("PJ-LOTE008");
  });

  it("não permite misturar PF e PJ", () => {
    const lote: Lote = {
      id: "PF-LOTE001",
      origem: "PF",
      itens: [{ identidade: criarIdentidade("PJ", "000001") }],
    };
    expect(() => validarItensDoLote(lote)).toThrow("incompatível");
  });

  it("não permite identidade repetida no mesmo lote", () => {
    const identidade = criarIdentidade("PJ", "000001");
    const lote: Lote = {
      id: "PJ-LOTE001",
      origem: "PJ",
      itens: [{ identidade }, { identidade }],
    };
    expect(() => validarItensDoLote(lote)).toThrow("duplicada");
  });

  it("não permite identificador de outra origem", () => {
    const lote: Lote = {
      id: "PJ-LOTE001",
      origem: "PF",
      itens: [],
    };
    expect(() => validarItensDoLote(lote)).toThrow("incompatível");
  });
});

describe("reconciliação", () => {
  it("preserva a regressão confirmada do PJ-LOTE01", () => {
    expect(reconciliarContagens(20, 13, 7)).toEqual({
      enviados: 20,
      confirmados: 13,
      rejeitados: 7,
      reconciliados: 20,
      completa: true,
    });
  });

  it("não aceita contagens fracionárias ou negativas", () => {
    expect(() => reconciliarContagens(20, 13.5, 6.5)).toThrow("inteiro não negativo");
    expect(() => reconciliarContagens(20, 21, -1)).toThrow("inteiro não negativo");
  });
});
