import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCANNER = path.resolve("scripts/security-scan.mjs");

// Fixtures sintéticas (nunca valores reais).
const SECRET_FIXTURE = `re_${"A".repeat(30)}`; // casa com resend-api-key
const DSN_SINTETICO = [
  "postgresql://integra_test",
  ":integra_test_ephemeral",
  "@localhost:5432/integra_correios_test",
].join(""); // dsn-with-credentials permitido somente na CI
const DSN_HISTORICO_DOCUMENTADO = [
  "postgres://user",
  ":senha",
  "@...",
].join("");
const PII_FIXTURE = ["123", ".456", ".789", "-09"].join(""); // cpf-formatado

function calcularDigito(base, pesos) {
  const soma = pesos.reduce(
    (total, peso, indice) => total + Number(base[indice]) * peso,
    0,
  );
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function cpfSintetico(base) {
  const primeiro = calcularDigito(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = calcularDigito(`${base}${primeiro}`, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${primeiro}${segundo}`;
}

function cnpjSintetico(base) {
  const primeiro = calcularDigito(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = calcularDigito(`${base}${primeiro}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${primeiro}${segundo}`;
}

function criarRepoTemp(arquivos) {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-test-"));
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // O snapshot usa git ls-files --cached: basta indexar, sem commit.
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function commitRepo(cwd, message) {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Integra Test",
      "-c",
      "user.email=integra-test@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function rodarScanner(mode, cwd, range = null) {
  const env = { ...process.env };
  delete env.SECURITY_SCAN_BASE_SHA;
  delete env.SECURITY_SCAN_HEAD_SHA;
  if (range) {
    env.SECURITY_SCAN_BASE_SHA = range.base;
    env.SECURITY_SCAN_HEAD_SHA = range.head;
  }
  try {
    const out = execFileSync("node", [SCANNER, mode], {
      cwd,
      encoding: "utf8",
      env,
    });
    return { code: 0, out };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: String(error.stdout ?? "") + String(error.stderr ?? ""),
    };
  }
}

describe("security scan — contrato executável", () => {
  it("modo secrets passa no repositório atual e sai 0", () => {
    const r = rodarScanner("secrets", process.cwd());
    expect(r.code).toBe(0);
    expect(r.out).toContain("Secret scan: PASS");
  });

  it("modo pii passa no repositório atual e sai 0", () => {
    const r = rodarScanner("pii", process.cwd());
    expect(r.code).toBe(0);
    expect(r.out).toContain("PII scan: PASS");
  });

  it("modo inválido sai com código 2", () => {
    const r = rodarScanner("invalido", process.cwd());
    expect(r.code).toBe(2);
  });

  it("detecta secret em fixture rastreada: exit 1, regra+local no stderr", () => {
    const dir = criarRepoTemp({
      "docs/exemplo.md": `chave: ${SECRET_FIXTURE}\n`,
    });
    try {
      const r = rodarScanner("secrets", dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("VIOLATION [resend-api-key]");
      expect(r.out).toContain("docs/exemplo.md:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saída NUNCA reproduz o valor casado", () => {
    const dir = criarRepoTemp({
      "docs/exemplo.md": `chave: ${SECRET_FIXTURE}\ncpf: ${PII_FIXTURE}\n`,
    });
    try {
      const rs = rodarScanner("secrets", dir);
      expect(rs.out).not.toContain(SECRET_FIXTURE);
      const rp = rodarScanner("pii", dir);
      expect(rp.code).toBe(1);
      expect(rp.out).toContain("VIOLATION [cpf-formatado]");
      expect(rp.out).not.toContain(PII_FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allowlist é NARROW: DSN sintético em ci.yml é relevado, mas outras regras no mesmo arquivo são reportadas", () => {
    const dir = criarRepoTemp({
      ".github/workflows/ci.yml": `url: ${DSN_SINTETICO}\nchave: ${SECRET_FIXTURE}\n`,
    });
    try {
      const r = rodarScanner("secrets", dir);
      // DSN sintético de CI é exceção por regra; o secret na mesma NÃO é.
      expect(r.out).not.toContain("dsn-with-credentials");
      expect(r.code).toBe(1);
      expect(r.out).toContain("VIOLATION [resend-api-key]");
      expect(r.out).toContain(".github/workflows/ci.yml:2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exceção histórica exata não libera o mesmo match no snapshot atual", () => {
    const dir = criarRepoTemp({
      "docs/security/scan-rules.md": `exemplo: ${DSN_HISTORICO_DOCUMENTADO}\n`,
    });
    try {
      const r = rodarScanner("secrets", dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("VIOLATION [dsn-with-credentials]");
      expect(r.out).not.toContain(DSN_HISTORICO_DOCUMENTADO);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const arquivo of [
    "scripts/security-scan.mjs",
    "tests/security-scan.test.mjs",
    "docs/security/scan-rules.md",
  ]) {
    it(`não desabilita todas as regras em ${arquivo}`, () => {
      const dir = criarRepoTemp({
        [arquivo]: `chave: ${SECRET_FIXTURE}\n`,
      });
      try {
        const r = rodarScanner("secrets", dir);
        expect(r.code).toBe(1);
        expect(r.out).toContain("VIOLATION [resend-api-key]");
        expect(r.out).toContain(`${arquivo}:1`);
        expect(r.out).not.toContain(SECRET_FIXTURE);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("detecta CPF e CNPJ válidos sem máscara em docs/fixtures", () => {
    const cpf = cpfSintetico("314159265");
    const cnpj = cnpjSintetico("271828180001");
    const dir = criarRepoTemp({
      "docs/identificadores.md": `cpf: ${cpf}\ncnpj: ${cnpj}\n`,
    });
    try {
      const r = rodarScanner("pii", dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("VIOLATION [cpf-sem-mascara]");
      expect(r.out).toContain("VIOLATION [cnpj-sem-mascara]");
      expect(r.out).not.toContain(cpf);
      expect(r.out).not.toContain(cnpj);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não sinaliza sequências sem máscara com DV inválido ou fora do escopo", () => {
    const cpf = cpfSintetico("314159265");
    const cnpj = cnpjSintetico("271828180001");
    const dir = criarRepoTemp({
      "docs/invalidos.md": "cpf: 31415926500\ncnpj: 27182818000100\nrepetido: 11111111111\n",
      "src/fora-do-escopo.txt": `cpf: ${cpf}\ncnpj: ${cnpj}\n`,
    });
    try {
      const r = rodarScanner("pii", dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain("PII scan: PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta secret e PII removidos do snapshot, mas presentes em commit intermediário", () => {
    const cpf = cpfSintetico("314159265");
    const dir = criarRepoTemp({ "docs/historico.md": "# limpo\n" });
    try {
      const base = commitRepo(dir, "base limpa");
      writeFileSync(
        path.join(dir, "docs/historico.md"),
        `chave: ${SECRET_FIXTURE}\ncpf: ${cpf}\n`,
      );
      const exposed = commitRepo(dir, "adiciona fixture bloqueada");
      writeFileSync(path.join(dir, "docs/historico.md"), "# limpo novamente\n");
      const head = commitRepo(dir, "remove fixture bloqueada");

      const secretResult = rodarScanner("secrets", dir, { base, head });
      expect(secretResult.code).toBe(1);
      expect(secretResult.out).toContain("VIOLATION [resend-api-key]");
      expect(secretResult.out).toContain(`commit ${exposed.slice(0, 12)}:docs/historico.md:1`);
      expect(secretResult.out).not.toContain(SECRET_FIXTURE);

      const piiResult = rodarScanner("pii", dir, { base, head });
      expect(piiResult.code).toBe(1);
      expect(piiResult.out).toContain("VIOLATION [cpf-sem-mascara]");
      expect(piiResult.out).toContain(`commit ${exposed.slice(0, 12)}:docs/historico.md:2`);
      expect(piiResult.out).not.toContain(cpf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repositório temporário limpo passa (sem falsos positivos)", () => {
    const dir = criarRepoTemp({ "README.md": "# exemplo\n" });
    try {
      const rs = rodarScanner("secrets", dir);
      expect(rs.code).toBe(0);
      const rp = rodarScanner("pii", dir);
      expect(rp.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
