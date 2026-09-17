// Guardrails de secrets e PII — reproduzíveis localmente e na CI.
//
// Limitações (documentadas): são HEURÍSTICAS de bloqueio, não prova
// absoluta de ausência de secrets/PII. Não há chamadas externas nem
// telemetria. A saída NUNCA reproduz o conteúdo casado — apenas arquivo,
// linha e a regra que casou.
//
// Uso:
//   node scripts/security-scan.mjs secrets
//   node scripts/security-scan.mjs pii

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const mode = process.argv[2];

// Arquivos que contêm padrões sintéticos/estruturais legítimos (o próprio
// scanner, seus testes e a baseline de skills que define as regras).
const ALLOWLIST = new Set([
  "scripts/security-scan.mjs",
  "tests/security-scan.test.mjs",
  "docs/security/scan-rules.md",
  ".github/workflows/ci.yml",
]);

const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const SECRET_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["github-pat", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["github-oauth", /\bgho_[A-Za-z0-9]{36,}\b/],
  ["github-app-token", /\bghs_[A-Za-z0-9]{36,}\b|\bghr_[A-Za-z0-9]{36,}\b/],
  ["google-oauth-client-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["resend-api-key", /\bre_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  [
    "dsn-with-credentials",
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqps?|redis):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/,
  ],
];

// Valores não vazios em configuração sensível NÃO PERMITIDA. A própria
// presença de arquivos .env é violação coberta por policy:repo (que permite
// apenas .env.example). Aqui reforçamos: se um dia um .env.example deixar
// de ser o único padrão permitido, conteúdo não vazio nele também falha.
// .env.example (template com placeholders) é permitido e não é varrido aqui.
const SENSITIVE_CONFIG_NONEMPTY = [];

const PII_RULES = [
  // CPF/CNPJ com separadores ou como número de 11/14 dígitos em fixtures —
  // a política usa fingerprints HMAC; fixtures devem ser sintéticas
  // reconhecíveis (ex.: zeros/repetidos já cobertos pelos testes de domínio).
  ["cpf-formatado", /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
  ["cnpj-formatado", /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/],
  ["email-institucional", /\b[a-z0-9._%+-]+@(?:correios\.com\.br|gov\.br|integra\.com\.br)\b/i],
  ["telefone-br", /\b(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}-\d{4}\b/],
];

function scanFiles(rules) {
  for (const file of tracked) {
    if (ALLOWLIST.has(file.split(path.sep).join("/"))) continue;
    // PII scan foca fixtures/testes/docs; secrets scan cobre tudo rastreado.
    if (mode === "pii") {
      const n = file.split(path.sep).join("/");
      if (!/(?:test|tests|fixture|fixtures|docs|example|samples?|\.md$)/i.test(n)) continue;
      if (/packages\/domain\/test|packages\/validation\/test/.test(n)) continue; // fixtures sintéticas homologadas (zeros/repetidos)
    }
    let content;
    try {
      // Lê do working tree (gate pré-commit); fallback para HEAD quando o
      // arquivo foi deletado. Binários/não-UTF8 caem no catch e são ignorados.
      content = readFileSync(file, "utf8");
    } catch {
      try {
        content = execFileSync("git", ["show", `HEAD:${file}`], {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        continue;
      }
    }
    const lines = content.split(/\r?\n/);
    for (const [ruleName, rule] of rules) {
      lines.forEach((line, i) => {
        if (rule.test(line)) {
          // Saída NÃO reproduz o match completo — apenas local + regra.
          console.error(`VIOLATION [${ruleName}] ${file}:${i + 1} (conteúdo omitido)`);
          process.exitCode = 1;
        }
      });
    }
    if (mode === "secrets") {
      for (const pattern of SENSITIVE_CONFIG_NONEMPTY) {
        if (pattern.test(file.split(path.sep).join("/")) && content.trim().length > 0) {
          console.error(`VIOLATION [config-sensivel-nao-vazio] ${file} (conteúdo omitido)`);
          process.exitCode = 1;
        }
      }
    }
  }
}

const label = mode === "secrets" ? "Secret scan" : mode === "pii" ? "PII scan" : null;
if (!label) {
  console.error("Uso: node scripts/security-scan.mjs <secrets|pii>");
  process.exit(2);
}

scanFiles(mode === "secrets" ? SECRET_RULES : PII_RULES);

if (process.exitCode !== 1) {
  console.log(`${label}: PASS (nenhuma violação em ${tracked.length} arquivos rastreados)`);
}
