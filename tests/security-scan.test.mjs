import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCANNER = path.resolve("scripts/security-scan.mjs");

// Fixtures sintéticas (nunca valores reais).
const SECRET_FIXTURE = `re_${"A".repeat(30)}`; // casa com resend-api-key
const DSN_SINTETICO =
  "postgresql://integra_test:integra_test_ephemeral@localhost:5432/db"; // dsn-with-credentials
const PII_FIXTURE = "123.456.789-09"; // casa com cpf-formatado

function criarRepoTemp(arquivos) {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-test-"));
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // O scanner usa git ls-files --cached: basta indexar, sem commit.
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function rodarScanner(mode, cwd) {
  try {
    const out = execFileSync("node", [SCANNER, mode], {
      cwd,
      encoding: "utf8",
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
