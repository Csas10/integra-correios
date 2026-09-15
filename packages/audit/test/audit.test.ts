import { describe, expect, it } from "vitest";
import { calcularSha256, criarEventoAuditoria, isSha256 } from "../src/index.js";

describe("auditoria", () => {
  it("produz SHA-256 hexadecimal estável", () => {
    const first = calcularSha256("estrutura-sem-dados");
    const second = calcularSha256("estrutura-sem-dados");
    expect(first).toBe(second);
    expect(isSha256(first)).toBe(true);
  });

  it("cria evento imutável com timestamp ISO", () => {
    const evento = criarEventoAuditoria({
      id: "evento-1",
      ocorreuEm: new Date("2026-09-15T00:00:00.000Z"),
      tipo: "GATE_REGISTRADO",
      agregadoId: "PJ-LOTE001",
      metadados: { resultado: "PASS" },
    });
    expect(evento.ocorreuEm).toBe("2026-09-15T00:00:00.000Z");
    expect(Object.isFrozen(evento)).toBe(true);
    expect(Object.isFrozen(evento.metadados)).toBe(true);
  });
});
