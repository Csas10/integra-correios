import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const violations = [];
const forbiddenNames = /(^|\/)\.env(?:\.|$)/;
const forbiddenDataExtensions = /\.(?:csv|tsv|xlsx?|pdf|jsonl|ndjson)$/i;
const sheetJsTarball = "vendor/xlsx-0.20.3.tgz";
const sheetJsSha256 = "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8";

for (const file of tracked) {
  const normalized = file.split(path.sep).join("/");
  if (forbiddenNames.test(normalized) && !normalized.endsWith(".env.example")) {
    violations.push(`${file}: arquivo de ambiente não permitido`);
  }
  if (forbiddenDataExtensions.test(normalized)) {
    violations.push(`${file}: arquivo de dados/binário não permitido`);
  }
  if (normalized.includes("node_modules/") || normalized.includes("/dist/")) {
    violations.push(`${file}: artefato gerado não permitido`);
  }
}

if (!tracked.includes(sheetJsTarball)) {
  violations.push(`${sheetJsTarball}: tarball oficial ausente`);
} else {
  const digest = createHash("sha256")
    .update(readFileSync(sheetJsTarball))
    .digest("hex");
  if (digest !== sheetJsSha256) {
    violations.push(`${sheetJsTarball}: SHA-256 divergente (${digest})`);
  }
}

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
if (rootPackage.dependencies?.xlsx !== `file:${sheetJsTarball}`) {
  violations.push(`package.json: xlsx deve referenciar file:${sheetJsTarball}`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Repository policy: PASS (${tracked.length} tracked files checked)`);
}
