import { createHash } from "node:crypto";

export type Sha256 = string & { readonly __brand: "Sha256" };

export function calcularSha256(content: string | Uint8Array): Sha256 {
  return createHash("sha256").update(content).digest("hex") as Sha256;
}

export function isSha256(value: string): value is Sha256 {
  return /^[a-f0-9]{64}$/.test(value);
}
