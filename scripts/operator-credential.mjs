#!/usr/bin/env node
import {
  generateCredentialMaterial,
  writeCredentialArtifact,
} from "./operator-credential-lib.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outArg = outIndex >= 0 ? args[outIndex + 1] : undefined;

if (!outArg) {
  process.stderr.write(
    "Uso: node scripts/operator-credential.mjs --out <arquivo.operator-credential.json>\n",
  );
  process.exit(2);
}

try {
  const material = generateCredentialMaterial();
  const outputPath = writeCredentialArtifact(outArg, material);
  process.stdout.write(`credential_hash=${material.credentialHash}\n`);
  process.stdout.write(`artifact=${outputPath}\n`);
} catch (error) {
  process.stderr.write(
    `Falha segura ao gerar credencial: ${error instanceof Error ? error.message : "erro desconhecido"}\n`,
  );
  process.exit(1);
}
