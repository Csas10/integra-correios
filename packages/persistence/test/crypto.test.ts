import { describe, expect, it } from "vitest";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  loadPersistenceSecurityConfig,
} from "../src/index.js";

describe("proteção de dados operacionais", () => {
  it("cifra com AES-256-GCM e vincula o ciphertext ao contexto", () => {
    const box = new Aes256GcmSecretBox(Buffer.alloc(32, 7), "test-v1");
    const sealed = box.seal("valor-sintetico", "profissional:documento");

    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("valor-sintetico");
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(
      Buffer.from(box.open(sealed, "profissional:documento")).toString("utf8"),
    ).toBe("valor-sintetico");
    expect(() => box.open(sealed, "oauth:access-token")).toThrow();
  });

  it("produz fingerprints HMAC determinísticos, isolados por namespace", () => {
    const fingerprinter = new HmacSha256Fingerprinter(Buffer.alloc(32, 11));
    const first = fingerprinter.fingerprint("documento:PF", "00000000000");
    const repeated = fingerprinter.fingerprint("documento:PF", "00000000000");
    const otherNamespace = fingerprinter.fingerprint("email", "00000000000");

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(otherNamespace).not.toBe(first);
  });

  it("falha fechado quando chaves de ambiente estão ausentes ou mal dimensionadas", () => {
    expect(() => loadPersistenceSecurityConfig({})).toThrow("não configurada");
    expect(() => loadPersistenceSecurityConfig({
      DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(16).toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "test-v1",
      DOCUMENT_FINGERPRINT_KEY_BASE64: Buffer.alloc(32).toString("base64"),
    })).toThrow("32 bytes");
  });
});
