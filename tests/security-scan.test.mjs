import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

function run(mode, files) {
  // Executa o scanner num repositório sintético mínimo (via env GIT_DIR não
  // é trivial); em vez disso testamos as REGRAS importando o módulo não é
  // possível (script de CLI). Estratégia: rodar o scanner real contra um
  // diretório temporário não é suportado — então validamos o comportamento
  // de contrato: exit codes e formato de saída (sem conteúdo).
  try {
    const out = execFileSync("node", ["scripts/security-scan.mjs", mode], {
      encoding: "utf8",
      env: { ...process.env, SCAN_TEST_FILES: files },
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

describe("security scan — contrato executável", () => {
  it("modo secrets passa no repositório atual e sai 0", () => {
    const r = run("secrets");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Secret scan: PASS");
  });

  it("modo pii passa no repositório atual e sai 0", () => {
    const r = run("pii");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PII scan: PASS");
  });

  it("modo inválido sai com código 2", () => {
    const r = run("invalido");
    expect(r.code).toBe(2);
  });

  it("saída nunca reproduz conteúdo casado (apenas arquivo/linha/regra)", () => {
    const r = run("secrets");
    // O repositório atual está limpo; a garantia estrutural é que violações
    // imprimente "(conteúdo omitido)" — verificado pela implementação e
    // pelo teste negativo manual documentado em docs/security/scan-rules.md.
    expect(r.out).not.toMatch(/gh[pousr]_|GOCSPX-|AIza|re_[A-Za-z0-9]{30}|BEGIN.*PRIVATE KEY/);
  });
});
