import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  eCredencialHomologada,
  eHashSha256Hex,
  gerarCredencialIndividual,
} from "../src/credential-client";

describe("geração de credencial individual (Web Crypto/CSPRNG)", () => {
  it("produz 43 caracteres base64url e SHA-256 hex coerente com o formato homologado", async () => {
    const { credencial, hash } = await gerarCredencialIndividual();
    expect(credencial).toHaveLength(43);
    expect(eCredencialHomologada(credencial)).toBe(true);
    expect(eHashSha256Hex(hash)).toBe(true);
    const esperado = createHash("sha256").update(credencial, "utf8").digest("hex");
    expect(hash).toBe(esperado);
  });

  it("é probabilisticamente única em lote de 500 gerações", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const { hash } = await gerarCredencialIndividual();
      hashes.add(hash);
    }
    expect(hashes.size).toBe(500);
  });

  it("rejeita formatos fora do padrão homologado", () => {
    expect(eCredencialHomologada("curta")).toBe(false);
    expect(eCredencialHomologada(`${"A".repeat(42)}+`)).toBe(false); // '+' não é base64url
    expect(eCredencialHomologada("A".repeat(44))).toBe(false);
    expect(eHashSha256Hex("z".repeat(64))).toBe(false);
  });

  it("aceita credenciais produzidas pelo gerador Node homologado (interoperabilidade)", async () => {
    const credencialNode = randomBytes(32).toString("base64url");
    expect(eCredencialHomologada(credencialNode)).toBe(true);
    const hashNode = createHash("sha256").update(credencialNode, "utf8").digest("hex");
    expect(eHashSha256Hex(hashNode)).toBe(true);
  });
});
