import { describe, expect, it } from "vitest";
import {
  cnpjValido,
  cpfValido,
  identificadorComZeros,
  normalizarCep,
  validarCabecalhos,
} from "../src/index.js";

function cpfFromBase(base: readonly number[]): string {
  const digits = [...base];
  const appendDigit = (weightsStart: number): void => {
    const sum = digits.reduce((total, digit, index) => total + digit * (weightsStart - index), 0);
    const result = (sum * 10) % 11;
    digits.push(result === 10 ? 0 : result);
  };
  appendDigit(10);
  appendDigit(11);
  return digits.join("");
}

function cnpjFromBase(base: readonly number[]): string {
  const digits = [...base];
  const appendDigit = (weights: readonly number[]): void => {
    const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
    const remainder = sum % 11;
    digits.push(remainder < 2 ? 0 : 11 - remainder);
  };
  appendDigit([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  appendDigit([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return digits.join("");
}

describe("identificadores textuais", () => {
  it("preserva zeros à esquerda", () => {
    expect(identificadorComZeros("42", 6)).toBe("000042");
  });

  it("normaliza CEP como texto com oito dígitos", () => {
    expect(normalizarCep("12.345-678")).toBe("12345678");
  });
});

describe("documentos", () => {
  it("valida CPF pelos dígitos verificadores", () => {
    const value = cpfFromBase([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cpfValido(value)).toBe(true);
    expect(cpfValido(`${value.slice(0, -1)}0`)).toBe(false);
  });

  it("valida CNPJ pelos dígitos verificadores", () => {
    const value = cnpjFromBase([1, 1, 2, 2, 2, 3, 3, 3, 0, 0, 0, 1]);
    expect(cnpjValido(value)).toBe(true);
    expect(cnpjValido("0".repeat(14))).toBe(false);
  });
});

describe("cabeçalhos", () => {
  it("informa campos ausentes e duplicados", () => {
    const result = validarCabecalhos(["Código", "codigo"], ["Código", "Nome"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["Nome"]);
    expect(result.duplicated).toEqual(["CODIGO"]);
  });
});
