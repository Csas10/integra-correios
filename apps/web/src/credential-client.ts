/**
 * Credencial individual — geração no cliente com CSPRNG de 256 bits.
 * Formato idêntico ao homologado (scripts/operator-credential-lib.mjs):
 * 32 bytes CSPRNG -> 43 caracteres base64url -> SHA-256 UTF-8 hex.
 * A API administrativa recebe SOMENTE o hash (contrato preservado).
 */

export interface CredencialIndividual {
  readonly credencial: string;
  readonly hash: string;
}

export function eCredencialHomologada(credencial: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(credencial);
}

export function eHashSha256Hex(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

export async function gerarCredencialIndividual(): Promise<CredencialIndividual> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binario = "";
  for (const byte of bytes) binario += String.fromCharCode(byte);
  // base64url byte-exato com o gerador Node homologado (32 bytes -> 43 chars).
  const credencial = btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (!eCredencialHomologada(credencial)) {
    throw new Error("Credencial gerada viola o formato homologado (43 chars base64url)");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credencial));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!eHashSha256Hex(hash)) {
    throw new Error("Hash derivado viola o formato SHA-256 hex");
  }
  return { credencial, hash };
}
