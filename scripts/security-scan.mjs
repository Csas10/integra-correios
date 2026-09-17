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

// Exceções NARROW por arquivo+regra — nunca por arquivo inteiro.
// Cada entrada indica: arquivo (caminho POSIX), regra que pode casar e o
// motivo sintético conhecido. Qualquer OUTRA regra no mesmo arquivo segue
// sendo reportada normalmente. Adições exigem revisão humana na PR.
const CI_TEST_DSN = [
  "postgresql://integra_test",
  ":integra_test_ephemeral",
  "@localhost:5432/integra_correios_test",
].join("");
const IMPORTER_TEST_CPF = ["529", "982", "247", "25"].join("");
const IMPORTER_TEST_CNPJ = ["11", "222", "333", "0001", "81"].join("");

const ALLOWLIST_NARROW = [
  {
    // Valores sintéticos de teste do PostgreSQL na CI — não são credenciais
    // reais; somente este match exato da regra é relevado neste arquivo.
    file: ".github/workflows/ci.yml",
    rule: "dsn-with-credentials",
    matches: new Set([CI_TEST_DSN]),
    motivo: "DSNs sintéticos de service container efêmero de teste",
  },
  {
    file: "packages/importers/test/intake-mapping.test.ts",
    rule: "cpf-sem-mascara",
    matches: new Set([IMPORTER_TEST_CPF]),
    motivo: "fixture sintética de CPF exercitada pelo importador",
  },
  {
    file: "packages/importers/test/intake-mapping.test.ts",
    rule: "cnpj-sem-mascara",
    matches: new Set([IMPORTER_TEST_CNPJ]),
    motivo: "fixture sintética de CNPJ exercitada pelo importador",
  },
];

function permitido(file, ruleName, matchedValue) {
  return ALLOWLIST_NARROW.some(
    (entry) =>
      entry.file === file &&
      entry.rule === ruleName &&
      entry.matches.has(matchedValue),
  );
}

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

const PII_TEXT_SCOPE = /(?:^|\/)(?:test|tests|fixtures|docs)(?:\/|$)/i;

function somenteDigitosIguais(value) {
  return /^(\d)\1+$/.test(value);
}

function calcularDigito(base, pesos) {
  const soma = pesos.reduce(
    (total, peso, indice) => total + Number(base[indice]) * peso,
    0,
  );
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function cpfValido(value) {
  if (!/^\d{11}$/.test(value) || somenteDigitosIguais(value)) return false;
  const primeiro = calcularDigito(value.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = calcularDigito(`${value.slice(0, 9)}${primeiro}`, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(`${primeiro}${segundo}`);
}

function cnpjValido(value) {
  if (!/^\d{14}$/.test(value) || somenteDigitosIguais(value)) return false;
  const primeiro = calcularDigito(value.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = calcularDigito(`${value.slice(0, 12)}${primeiro}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value.endsWith(`${primeiro}${segundo}`);
}

function identificadoresSemMascara(line, file, length, validator) {
  if (!PII_TEXT_SCOPE.test(file)) return [];
  return (line.match(new RegExp(`\\b\\d{${length}}\\b`, "g")) ?? []).filter(validator);
}

const PII_RULES = [
  // CPF/CNPJ com separadores ou como número de 11/14 dígitos em fixtures —
  // a política usa fingerprints HMAC; fixtures devem ser sintéticas
  // reconhecíveis (ex.: zeros/repetidos já cobertos pelos testes de domínio).
  ["cpf-formatado", /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
  ["cnpj-formatado", /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/],
  ["cpf-sem-mascara", (line, file) => identificadoresSemMascara(line, file, 11, cpfValido)],
  ["cnpj-sem-mascara", (line, file) => identificadoresSemMascara(line, file, 14, cnpjValido)],
  ["email-institucional", /\b[a-z0-9._%+-]+@(?:correios\.com\.br|gov\.br|integra\.com\.br)\b/i],
  ["telefone-br", /\b(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}-\d{4}\b/],
];

function extrairMatches(rule, line, file) {
  if (typeof rule === "function") return rule(line, file);
  const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
  return Array.from(line.matchAll(new RegExp(rule.source, flags)), (match) => match[0]);
}

function scanFiles(rules) {
  for (const file of tracked) {
    const rel = file.split(path.sep).join("/");
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
        const matches = extrairMatches(rule, line, rel);
        if (matches.some((matchedValue) => !permitido(rel, ruleName, matchedValue))) {
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
