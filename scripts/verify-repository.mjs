import { execFileSync } from "node:child_process";
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

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Repository policy: PASS (${tracked.length} tracked files checked)`);
}
