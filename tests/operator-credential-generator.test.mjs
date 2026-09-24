import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("gerador controlado de credencial operacional", () => {
  it("gera 256 bits, grava 0600, não imprime segredo e não sobrescreve artefato", () => {
    const dir = mkdtempSync(join(tmpdir(), "integra-operator-credential-"));
    const artifactPath = join(dir, "admin.operator-credential.json");
    const scriptPath = resolve("scripts/operator-credential.mjs");

    const first = spawnSync(
      process.execPath,
      [scriptPath, "--out", artifactPath],
      { encoding: "utf8" },
    );
    expect(first.status).toBe(0);

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact.version).toBe(1);
    expect(artifact.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(artifact.credentialHash).toBe(
      createHash("sha256").update(artifact.credential, "utf8").digest("hex"),
    );
    expect(first.stdout).toContain(artifact.credentialHash);
    expect(first.stdout).not.toContain(artifact.credential);
    expect(first.stderr).not.toContain(artifact.credential);
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);

    const original = readFileSync(artifactPath, "utf8");
    const second = spawnSync(
      process.execPath,
      [scriptPath, "--out", artifactPath],
      { encoding: "utf8" },
    );
    expect(second.status).not.toBe(0);
    expect(readFileSync(artifactPath, "utf8")).toBe(original);
  });
});
