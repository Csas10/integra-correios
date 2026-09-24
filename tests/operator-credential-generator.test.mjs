import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CredentialArtifactSecurityError,
  generateCredentialMaterial,
  writeCredentialArtifact,
} from "../scripts/operator-credential-lib.mjs";

const itPosix = process.platform === "win32" ? it.skip : it;
const itWindows = process.platform === "win32" ? it : it.skip;

describe("gerador controlado de credencial operacional", () => {
  itPosix("gera 256 bits, confirma 0600, não imprime segredo e não sobrescreve artefato", () => {
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

  it("política Windows falha fechado antes de criar arquivo secreto", () => {
    const dir = mkdtempSync(join(tmpdir(), "integra-operator-win32-"));
    const artifactPath = join(dir, "blocked.operator-credential.json");
    const material = generateCredentialMaterial();

    expect(() =>
      writeCredentialArtifact(artifactPath, material, "win32"),
    ).toThrow(CredentialArtifactSecurityError);
    expect(existsSync(artifactPath)).toBe(false);
  });

  itWindows("CLI real no Windows também falha fechado sem criar artefato", () => {
    const dir = mkdtempSync(join(tmpdir(), "integra-operator-win32-cli-"));
    const artifactPath = join(dir, "blocked.operator-credential.json");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/operator-credential.mjs"), "--out", artifactPath],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WINDOWS_ACL_UNSUPPORTED");
    expect(existsSync(artifactPath)).toBe(false);
  });
});
