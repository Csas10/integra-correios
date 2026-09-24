#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outArg = outIndex >= 0 ? args[outIndex + 1] : undefined;

if (!outArg || !outArg.endsWith(".operator-credential.json")) {
  process.stderr.write(
    "Uso: node scripts/operator-credential.mjs --out <arquivo.operator-credential.json>\n",
  );
  process.exit(2);
}

const outputPath = resolve(outArg);
const credential = randomBytes(32).toString("base64url");
const credentialHash = createHash("sha256")
  .update(credential, "utf8")
  .digest("hex");

try {
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        credential,
        credentialHash,
      },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  chmodSync(outputPath, 0o600);
} catch (error) {
  process.stderr.write(
    `Falha ao criar artefato de credencial: ${error instanceof Error ? error.message : "erro desconhecido"}\n`,
  );
  process.exit(1);
}

process.stdout.write(`credential_hash=${credentialHash}\n`);
process.stdout.write(`artifact=${outputPath}\n`);
