import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export class CredentialArtifactSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialArtifactSecurityError";
  }
}

export function assertCredentialArtifactPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new CredentialArtifactSecurityError(
      "WINDOWS_ACL_UNSUPPORTED: geração de artefato secreto bloqueada no Windows",
    );
  }
}

export function generateCredentialMaterial() {
  const credential = randomBytes(32).toString("base64url");
  const credentialHash = createHash("sha256")
    .update(credential, "utf8")
    .digest("hex");
  return { credential, credentialHash };
}

export function writeCredentialArtifact(
  outArg,
  material,
  platform = process.platform,
) {
  assertCredentialArtifactPlatform(platform);
  if (!outArg || !outArg.endsWith(".operator-credential.json")) {
    throw new CredentialArtifactSecurityError(
      "Destino deve terminar em .operator-credential.json",
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(material.credential)) {
    throw new CredentialArtifactSecurityError("Credencial deve conter 256 bits");
  }
  if (!/^[a-f0-9]{64}$/.test(material.credentialHash)) {
    throw new CredentialArtifactSecurityError("Hash de credencial inválido");
  }

  const outputPath = resolve(outArg);
  try {
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          credential: material.credential,
          credentialHash: material.credentialHash,
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(outputPath, 0o600);
    const mode = statSync(outputPath).mode & 0o777;
    if (mode !== 0o600) {
      throw new CredentialArtifactSecurityError(
        "Permissões do artefato não puderam ser confirmadas como 0600",
      );
    }
    return outputPath;
  } catch (error) {
    if (existsSync(outputPath)) {
      try { unlinkSync(outputPath); } catch {}
    }
    throw error;
  }
}

export function removeCredentialArtifact(path) {
  if (!path || !existsSync(path)) return;
  try { unlinkSync(path); } catch {}
}
