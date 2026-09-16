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

// Baseline canônica de skills versionadas em .claude/skills/.
// Validação estrutural apenas: existência do diretório, presença de
// SKILL.md e YAML frontmatter mínimo. NÃO valida conteúdo semântico.
const REQUIRED_SKILLS = [
  "agent-operating-model",
  "correios-golden-profile",
  "gmail-integration",
  "intake-mapping-engine",
  "legacy-regression",
  "operational-persistence",
  "pf-workflow",
  "ppn-orchestration",
  "quality-gate",
  "repo-governance",
  "security-privacy",
  "web-operational-flow",
];

function parseSkillFrontmatter(content) {
  // Frontmatter YAML mínimo: abre com --- na linha 1, fecha com --- e
  // contém `name:` e `description:` não vazios. Sem parser semântico.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return null;
  const frontmatter = match[1];
  const name = /^name:\s*(\S.*)$/m.exec(frontmatter)?.[1]?.trim();
  const description = /^description:\s*(\S.*)$/m.exec(frontmatter)?.[1]?.trim();
  if (!name || !description) return null;
  return { name, description };
}

for (const skill of REQUIRED_SKILLS) {
  const skillPath = `.claude/skills/${skill}/SKILL.md`;
  if (!tracked.includes(skillPath)) {
    violations.push(`${skillPath}: skill obrigatória ausente`);
    continue;
  }
  const frontmatter = parseSkillFrontmatter(readFileSync(skillPath, "utf8"));
  if (!frontmatter) {
    violations.push(`${skillPath}: YAML frontmatter inválido (name/description obrigatórios)`);
    continue;
  }
  if (frontmatter.name !== skill) {
    violations.push(
      `${skillPath}: frontmatter name "${frontmatter.name}" diverge do diretório "${skill}"`,
    );
  }
}

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
  if (normalized.startsWith(".claude/skills/") && normalized.endsWith("/SKILL.md")) {
    const skill = normalized.split("/")[2];
    if (!REQUIRED_SKILLS.includes(skill)) {
      violations.push(`${file}: skill fora da baseline canônica aprovada`);
    }
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
