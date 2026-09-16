import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedValue {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: string;
}

export interface SecretBox {
  seal(plaintext: string | Uint8Array, context: string): EncryptedValue;
  open(value: EncryptedValue, context: string): Uint8Array;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function requireKey(key: Uint8Array, name: string): Buffer {
  if (key.byteLength !== AES_KEY_BYTES) {
    throw new Error(`${name} deve conter exatamente ${AES_KEY_BYTES} bytes`);
  }
  return Buffer.from(key);
}

export class Aes256GcmSecretBox implements SecretBox {
  private readonly key: Buffer;

  constructor(key: Uint8Array, private readonly keyVersion: string) {
    this.key = requireKey(key, "Chave AES-256-GCM");
    if (!keyVersion.trim()) throw new Error("Versão da chave é obrigatória");
  }

  seal(plaintext: string | Uint8Array, context: string): EncryptedValue {
    if (!context.trim()) throw new Error("Contexto criptográfico é obrigatório");
    const nonce = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(bytes(plaintext)), cipher.final()]);
    return {
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      keyVersion: this.keyVersion,
    };
  }

  open(value: EncryptedValue, context: string): Uint8Array {
    if (value.keyVersion !== this.keyVersion) {
      throw new Error(`Versão de chave indisponível: ${value.keyVersion}`);
    }
    if (value.nonce.byteLength !== IV_BYTES || value.authTag.byteLength !== AUTH_TAG_BYTES) {
      throw new Error("Envelope criptográfico inválido");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, value.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(value.authTag));
    return Buffer.concat([
      decipher.update(value.ciphertext),
      decipher.final(),
    ]);
  }
}

export class HmacSha256Fingerprinter {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    this.key = requireKey(key, "Chave HMAC-SHA-256");
  }

  fingerprint(namespace: string, canonicalValue: string): string {
    if (!namespace.trim()) throw new Error("Namespace do fingerprint é obrigatório");
    if (!canonicalValue.trim()) throw new Error("Valor canônico é obrigatório");
    return createHmac("sha256", this.key)
      .update(namespace, "utf8")
      .update("\0", "utf8")
      .update(canonicalValue, "utf8")
      .digest("hex");
  }
}

export interface PersistenceSecurityConfig {
  readonly encryptionKey: Uint8Array;
  readonly encryptionKeyVersion: string;
  readonly fingerprintKey: Uint8Array;
}

function decodeKey(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`${name} não configurada`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== AES_KEY_BYTES) {
    throw new Error(`${name} deve decodificar para ${AES_KEY_BYTES} bytes`);
  }
  return decoded;
}

export function loadPersistenceSecurityConfig(
  environment: Readonly<Record<string, string | undefined>>,
): PersistenceSecurityConfig {
  const encryptionKeyVersion = environment.DATA_ENCRYPTION_KEY_VERSION?.trim();
  if (!encryptionKeyVersion) throw new Error("DATA_ENCRYPTION_KEY_VERSION não configurada");
  return {
    encryptionKey: decodeKey(environment.DATA_ENCRYPTION_KEY_BASE64, "DATA_ENCRYPTION_KEY_BASE64"),
    encryptionKeyVersion,
    fingerprintKey: decodeKey(
      environment.DOCUMENT_FINGERPRINT_KEY_BASE64,
      "DOCUMENT_FINGERPRINT_KEY_BASE64",
    ),
  };
}
