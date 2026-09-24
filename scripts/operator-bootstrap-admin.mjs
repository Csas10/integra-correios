#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  InitialAdminBootstrapError,
  NodePostgresPool,
  PostgresOperatorIdentityRepository,
} from "../packages/persistence/dist/index.js";
import {
  assertCredentialArtifactPlatform,
  generateCredentialMaterial,
  removeCredentialArtifact,
  writeCredentialArtifact,
} from "./operator-credential-lib.mjs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) return undefined;
  return value;
}

const args = process.argv.slice(2);
const code = valueAfter(args, "--code")?.trim();
const displayName = valueAfter(args, "--name")?.trim();
const outArg = valueAfter(args, "--out");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!code || !displayName || !outArg || !databaseUrl) {
  process.stderr.write(
    "Uso: DATABASE_URL=... npm run operator:bootstrap-admin -- --code <codigo> --name <nome> --out <arquivo.operator-credential.json>\n",
  );
  process.exit(2);
}

let artifactPath;
let pool;
try {
  assertCredentialArtifactPlatform();
  const material = generateCredentialMaterial();
  artifactPath = writeCredentialArtifact(outArg, material);

  const operatorId = randomUUID();
  pool = new NodePostgresPool({ connectionString: databaseUrl });
  const repository = new PostgresOperatorIdentityRepository(pool);
  await repository.bootstrapInitialAdmin({
    operatorId,
    code,
    displayName,
    tokenHash: material.credentialHash,
    now: new Date().toISOString(),
  });

  process.stdout.write(`operator_id=${operatorId}\n`);
  process.stdout.write(`credential_hash=${material.credentialHash}\n`);
  process.stdout.write(`artifact=${artifactPath}\n`);
} catch (error) {
  if (artifactPath) removeCredentialArtifact(artifactPath);
  if (error instanceof InitialAdminBootstrapError) {
    process.stderr.write(
      "Bootstrap inicial recusado: já existe operador neste banco.\n",
    );
  } else if (
    error instanceof Error &&
    error.message.startsWith("WINDOWS_ACL_UNSUPPORTED")
  ) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("Bootstrap inicial falhou de forma segura.\n");
  }
  process.exitCode = 1;
} finally {
  if (pool) await pool.close();
}
