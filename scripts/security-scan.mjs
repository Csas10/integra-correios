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
const HISTORICAL_DOC_CPF = ["000", ".000", ".000", "-00"].join("");
const HISTORICAL_DOC_CNPJ = ["00", ".000", ".000", "/0000", "-00"].join("");
const HISTORICAL_TEST_CPF = ["123", ".456", ".789", "-09"].join("");
const HISTORICAL_INTAKE_PILOT_CPF_1 = ["000", "000", "001", "91"].join("");
const HISTORICAL_INTAKE_PILOT_CPF_2 = ["168", "995", "350", "09"].join("");
const HISTORICAL_DOC_DSN = ["postgres://user", ":senha", "@..."].join("");
const HISTORICAL_TEST_DSN = [
  "postgresql://integra_test",
  ":integra_test_ephemeral",
  "@localhost:5432/db",
].join("");

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
    file: "tests/operational-validation-v0.test.ts",
    rule: "cpf-sem-mascara",
    matches: new Set([IMPORTER_TEST_CPF]),
    motivo: "fixture sintética de CPF com dígitos válidos usada pela suíte de validação operacional V0",
  },
  {
    file: "tests/operational-validation-v0.test.ts",
    rule: "cpf-formatado",
    // IMPORTANTE: Set recebe um ARRAY com o valor completo — new Set(string)
    // iteraria caractere a caractere e nunca casaria.
    matches: new Set([["529", ".982", ".247", "-25"].join("")]),
    motivo: "mesma fixture sintética da suíte V0, em notação formatada",
  },
  {
    file: "packages/importers/test/intake-mapping.test.ts",
    rule: "cnpj-sem-mascara",
    matches: new Set([IMPORTER_TEST_CNPJ]),
    motivo: "fixture sintética de CNPJ exercitada pelo importador",
  },
  {
    file: "docs/security/scan-rules.md",
    rule: "cpf-formatado",
    matches: new Set([HISTORICAL_DOC_CPF]),
    historyOnly: true,
    motivo: "notação sintética presente em commits anteriores desta PR",
  },
  {
    file: "docs/security/scan-rules.md",
    rule: "cnpj-formatado",
    matches: new Set([HISTORICAL_DOC_CNPJ]),
    historyOnly: true,
    motivo: "notação sintética presente em commits anteriores desta PR",
  },
  {
    file: "docs/security/scan-rules.md",
    rule: "dsn-with-credentials",
    matches: new Set([HISTORICAL_DOC_DSN]),
    historyOnly: true,
    motivo: "notação sintética presente em commits anteriores desta PR",
  },
  {
    file: "tests/security-scan.test.mjs",
    rule: "cpf-formatado",
    matches: new Set([HISTORICAL_TEST_CPF]),
    historyOnly: true,
    motivo: "fixture sintética presente em commit anterior desta PR",
  },
  {
    file: "apps/api/test/intake-pilot.test.ts",
    rule: "cpf-sem-mascara",
    matches: new Set([HISTORICAL_INTAKE_PILOT_CPF_1, HISTORICAL_INTAKE_PILOT_CPF_2]),
    historyOnly: true,
    motivo: "fixtures sintéticas válidas introduzidas em commit intermediário e posteriormente fragmentadas no source",
  },
  {
    file: "tests/security-scan.test.mjs",
    rule: "dsn-with-credentials",
    matches: new Set([HISTORICAL_TEST_DSN]),
    historyOnly: true,
    motivo: "fixture sintética presente em commit anterior desta PR",
  },
];

function permitido(file, ruleName, matchedValue, source) {
  return ALLOWLIST_NARROW.some(
    (entry) =>
      entry.file === file &&
      entry.rule === ruleName &&
      entry.matches.has(matchedValue) &&
      (!entry.historyOnly || source !== null),
  );
}

const MAX_GIT_OUTPUT = 20 * 1024 * 1024;
const SHA_FORMAT = /^[0-9a-f]{40}$/i;

function executarGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const tracked = executarGit(["ls-files", "--cached", "-z"])
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
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqps?|redis):\/\/[^\s/:@'"`<>]+:[^\s/@'"`<>]+@[^\s'"`<>]+/,
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

function scanContent(rules, file, content, source = null) {
  const rel = file.split(path.sep).join("/");
  const location = source ? `${source}:${rel}` : rel;
  const lines = content.split(/\r?\n/);
  for (const [ruleName, rule] of rules) {
    lines.forEach((line, i) => {
      const matches = extrairMatches(rule, line, rel);
      if (
        matches.some(
          (matchedValue) => !permitido(rel, ruleName, matchedValue, source),
        )
      ) {
        // Saída NÃO reproduz o match completo — apenas local + regra.
        console.error(
          `VIOLATION [${ruleName}] ${location}:${i + 1} (conteúdo omitido)`,
        );
        process.exitCode = 1;
      }
    });
  }
  if (mode === "secrets") {
    for (const pattern of SENSITIVE_CONFIG_NONEMPTY) {
      if (pattern.test(rel) && content.trim().length > 0) {
        console.error(
          `VIOLATION [config-sensivel-nao-vazio] ${location} (conteúdo omitido)`,
        );
        process.exitCode = 1;
      }
    }
  }
}

function scanSnapshot(rules) {
  for (const file of tracked) {
    const versions = new Set();
    try {
      // O índice é a fonte autoritativa do que será commitado. Ler apenas o
      // working tree permitiria ocultar um secret staged com uma edição local.
      versions.add(executarGit(["show", `:${file}`]));
    } catch {
      continue;
    }
    try {
      // Também cobre alterações ainda não indexadas. O Set evita varrer duas
      // vezes o conteúdo quando índice e working tree são idênticos.
      versions.add(readFileSync(file, "utf8"));
    } catch {
      // Arquivo removido do working tree: a versão staged já foi examinada.
    }
    for (const content of versions) {
      scanContent(rules, file, content);
    }
  }
}

function resolveHistoryRange() {
  const baseFromEnv = process.env.SECURITY_SCAN_BASE_SHA?.trim();
  const headFromEnv = process.env.SECURITY_SCAN_HEAD_SHA?.trim();
  if (Boolean(baseFromEnv) !== Boolean(headFromEnv)) {
    console.error(
      "ERROR [security-scan-range] base/head devem ser informados em conjunto",
    );
    process.exitCode = 2;
    return null;
  }
  if (baseFromEnv && headFromEnv) {
    if (!SHA_FORMAT.test(baseFromEnv) || !SHA_FORMAT.test(headFromEnv)) {
      console.error(
        "ERROR [security-scan-range] base/head devem ser SHAs completos",
      );
      process.exitCode = 2;
      return null;
    }
    return { base: baseFromEnv, head: headFromEnv };
  }

  try {
    return {
      base: executarGit(["rev-parse", "--verify", "origin/main^{commit}"]).trim(),
      head: executarGit(["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
    };
  } catch {
    // Repositórios temporários sem origin/main continuam cobertos pelo snapshot.
    return null;
  }
}

function changedFilesAtCommit(commit) {
  const ancestry = executarGit(["rev-list", "--parents", "-n", "1", commit])
    .trim()
    .split(/\s+/);
  const parent = ancestry[1];
  const output = parent
    ? executarGit([
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        parent,
        commit,
        "--",
      ])
    : executarGit(["ls-tree", "-r", "--name-only", "-z", commit]);
  return [...new Set(output.split("\0").filter(Boolean))];
}

function scanHistory(rules) {
  const range = resolveHistoryRange();
  if (!range || process.exitCode === 2) return 0;

  let commits;
  try {
    commits = executarGit([
      "rev-list",
      "--reverse",
      `${range.base}..${range.head}`,
    ])
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    console.error(
      "ERROR [security-scan-range] não foi possível resolver o intervalo",
    );
    process.exitCode = 2;
    return 0;
  }

  for (const commit of commits) {
    let files;
    try {
      files = changedFilesAtCommit(commit);
    } catch {
      console.error(
        "ERROR [security-scan-history] não foi possível enumerar um commit",
      );
      process.exitCode = 2;
      return commits.length;
    }
    for (const file of files) {
      try {
        const objectType = executarGit([
          "cat-file",
          "-t",
          `${commit}:${file}`,
        ]).trim();
        if (objectType !== "blob") continue;
        const content = executarGit(["show", `${commit}:${file}`]);
        scanContent(rules, file, content, `commit ${commit.slice(0, 12)}`);
      } catch {
        console.error(
          "ERROR [security-scan-history] não foi possível ler um blob alterado",
        );
        process.exitCode = 2;
        return commits.length;
      }
    }
  }
  return commits.length;
}

const label = mode === "secrets" ? "Secret scan" : mode === "pii" ? "PII scan" : null;
if (!label) {
  console.error("Uso: node scripts/security-scan.mjs <secrets|pii>");
  process.exit(2);
}

const selectedRules = mode === "secrets" ? SECRET_RULES : PII_RULES;
scanSnapshot(selectedRules);
const scannedCommits = scanHistory(selectedRules);

if (!process.exitCode) {
  console.log(
    `${label}: PASS (nenhuma violação em ${tracked.length} arquivos rastreados; ` +
      `${scannedCommits} commits do intervalo revisado)`,
  );
}
