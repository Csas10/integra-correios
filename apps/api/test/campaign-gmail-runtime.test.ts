/**
 * SLICE-03C.2B1A — testes do RUNTIME GMAIL REAL da campanha (LOCAL, STRICT
 * ZERO SEND). Zero rede real: a porta de refresh e o transport são fakes
 * explícitos; nenhuma chamada Google/Gmail ocorre em nenhum teste.
 *
 * Cobertura:
 *  A — conexão OAuth inexistente  → token undefined, refresh=0, send=0
 *  B — access token válido        → 1 leitura, 1 decrypt, refresh=0
 *  C — access token expirado + refresh token → refresh fake=1, novo envelope
 *      CIFRADO persistido (plaintext ausente do banco), expiração atualizada
 *  D — refresh token ausente      → CampanhaTokenResolutionError (pré-provider)
 *  E — refresh rejeitado/rede     → CampanhaTokenResolutionError (pré-provider)
 *  F — conta persistida divergente → fail closed (decrypt=0, refresh=0)
 *  G — conexão revogada           → fail closed (decrypt=0, refresh=0)
 *  I — erro tipado nunca é ambíguo nem rejeição de messages.send
 */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GmailMailGateway, MailProviderNaoConfiguradoError } from "@integra-correios/mail";
import { Aes256GcmSecretBox, type EncryptedValue } from "@integra-correios/persistence";
import {
  CampanhaTokenResolutionError,
  criarCampanhaGmailRuntime,
} from "../src/campaign-gmail-runtime.js";
import type { NodePostgresPool } from "@integra-correios/persistence";

const CHAVE_CRIPTO = Buffer.from("chave-cripto-live-03c2b1a".padEnd(32, "!"), "utf8"); // 32 bytes
const CHAVE_FP = Buffer.from("chave-fp-live-03c2b1a".padEnd(32, "#"), "utf8"); // 32 bytes
const CONTA_ESPERADA = "institucional.live@exemplo.test";
const CHAVE_VERSAO = "v1-live-test";

const ENV_COMPLETO = {
  GMAIL_OAUTH_CLIENT_ID: "client-id-sintetico",
  GMAIL_OAUTH_CLIENT_SECRET: "client-secret-sintetico",
  GMAIL_OAUTH_REDIRECT_URI: "https://exemplo.test/callback",
  GMAIL_EXPECTED_ACCOUNT: CONTA_ESPERADA,
  DOCUMENT_FINGERPRINT_KEY_BASE64: CHAVE_FP.toString("base64"),
  DATA_ENCRYPTION_KEY_BASE64: CHAVE_CRIPTO.toString("base64"),
  DATA_ENCRYPTION_KEY_VERSION: CHAVE_VERSAO,
} as Record<string, string>;

const ENV_INCOMPLETO: Record<string, string> = {
  // sem GMAIL_OAUTH_* ⇒ CONFIGURATION_REQUIRED ⇒ fail-closed
  GMAIL_EXPECTED_ACCOUNT: CONTA_ESPERADA,
  DOCUMENT_FINGERPRINT_KEY_BASE64: CHAVE_FP.toString("base64"),
  DATA_ENCRYPTION_KEY_BASE64: CHAVE_CRIPTO.toString("base64"),
  DATA_ENCRYPTION_KEY_VERSION: CHAVE_VERSAO,
};

interface PoolFake {
  consultas: string[];
  parametros: unknown[];
  resposta: unknown;
}

function poolFake(resposta: unknown): PoolFake & { query(q: string, v?: unknown[]): Promise<{ rows: unknown[] }> } {
  const estado: PoolFake = { consultas: [], parametros: [], resposta };
  return {
    consultas: estado.consultas,
    parametros: estado.parametros,
    async query(q: string, v?: unknown[]) {
      estado.consultas.push(q);
      estado.parametros.push(v ?? []);
      return { rows: resposta ? [resposta] : [] };
    },
  } as never;
}

function linhaConexao(opcoes: {
  id?: string;
  contaFingerprint?: string;
  expiraEm?: Date | null;
  comRefresh?: boolean;
  chaveVersao?: string;
  /** Envelope REAL (nonce/tag aleatórios do seal) — decrypt verificado. */
  envelope?: EncryptedValue;
}) {
  const comRefresh = opcoes.comRefresh ?? false;
  const envelope = opcoes.envelope;
  return {
    id: opcoes.id ?? randomUUID(),
    conta_fingerprint: opcoes.contaFingerprint ?? "f".repeat(64),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    access_token_ciphertext: envelope ? Buffer.from(envelope.ciphertext) : (opcoes.envelope === undefined ? Buffer.from("ct") : undefined) ?? Buffer.from("ct"),
    access_token_nonce: envelope ? Buffer.from(envelope.nonce) : Buffer.alloc(12, 1),
    access_token_auth_tag: envelope ? Buffer.from(envelope.authTag) : Buffer.alloc(16, 2),
    refresh_token_ciphertext: comRefresh ? Buffer.from("rt") : null,
    refresh_token_nonce: comRefresh ? Buffer.alloc(12, 3) : null,
    refresh_token_auth_tag: comRefresh ? Buffer.alloc(16, 4) : null,
    chave_versao: opcoes.chaveVersao ?? CHAVE_VERSAO,
    expira_em: opcoes.expiraEm === undefined ? new Date(Date.now() + 3_600_000) : opcoes.expiraEm,
  };
}

function caixa(): Aes256GcmSecretBox {
  return new Aes256GcmSecretBox(CHAVE_CRIPTO, CHAVE_VERSAO);
}

describe("SLICE_03C.2B1A — runtime Gmail real da campanha (strict zero send)", () => {
  it("fail-closed: configuração incompleta ⇒ resolver undefined SEM tocar banco/decrypt/rede", async () => {
    const pool = poolFake(undefined);
    const runtime = criarCampanhaGmailRuntime({ env: ENV_INCOMPLETO, pool: pool as never });
    const transportFake = vi.fn();
    const gateway = new GmailMailGateway(transportFake, runtime.loadAccessToken, undefined, { REAL_SEND_ENABLED: "true" });
    await expect(gateway.send({} as never)).rejects.toBeInstanceOf(MailProviderNaoConfiguradoError);
    expect(transportFake).not.toHaveBeenCalled();
    expect(pool.consultas.length).toBe(0);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
  });

  it("fail-closed: chave de criptografia com tamanho inválido ⇒ undefined (nunca constrói caixa vazia)", async () => {
    const pool = poolFake(undefined);
    const runtime = criarCampanhaGmailRuntime({
      env: { ...ENV_COMPLETO, DATA_ENCRYPTION_KEY_BASE64: Buffer.from("curta").toString("base64") },
      pool: pool as never,
    });
    await expect(runtime.loadAccessToken()).resolves.toBeUndefined();
    expect(pool.consultas.length).toBe(0);
  });

  it("A — conexão OAuth inexistente: token undefined, refresh=0, send=0", async () => {
    const pool = poolFake(undefined); // loadGmailConnection sem linhas
    const refreshFake = vi.fn(async () => ({ access_token: "novo", expires_in: 3600 }));
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never, portaRefresh: refreshFake });
    await expect(runtime.loadAccessToken()).resolves.toBeUndefined();
    expect(refreshFake).not.toHaveBeenCalled();
    expect(pool.consultas.length).toBe(1); // apenas a leitura da conexão
    expect(pool.consultas[0]).toContain("oauth_connection");
  });

  it("B — access token válido: 1 leitura, 1 decrypt, refresh=0, token só em memória", async () => {
    const caixaTeste = caixa();
    const envelope = caixaTeste.seal("token-valido-sintetico", "oauth:access");
    const linha = linhaConexao({ envelope });
    const pool = poolFake(linha);
    const refreshFake = vi.fn(async () => ({ access_token: "novo", expires_in: 3600 }));
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never, portaRefresh: refreshFake });
    const token = await runtime.loadAccessToken();
    expect(token).toBe("token-valido-sintetico");
    expect(refreshFake).not.toHaveBeenCalled();
    expect(runtime.metricas.leiturasConexao()).toBe(1);
    expect(runtime.metricas.descriptografias()).toBe(1);
    expect(runtime.metricas.refreshes()).toBe(0);
    // Persistência contém SOMENTE o envelope cifrado (nunca plaintext):
    expect(Buffer.from(linha.access_token_ciphertext).toString("utf8")).not.toContain("token-valido-sintetico");
  });

  it("C — access token expirado com refresh token: refresh fake=1, novo envelope CIFRADO persistido", async () => {
    const caixaTeste = caixa();
    const envelopeVelho = caixaTeste.seal("token-expirado-sintetico", "oauth:access");
    const envelopeRefresh = caixaTeste.seal("refresh-sintetico", "oauth:refresh");
    const linha = {
      ...linhaConexao({
        envelope: envelopeVelho,
        comRefresh: true,
        expiraEm: new Date(Date.now() - 60_000),
      }),
      refresh_token_ciphertext: Buffer.from(envelopeRefresh.ciphertext),
      refresh_token_nonce: Buffer.from(envelopeRefresh.nonce),
      refresh_token_auth_tag: Buffer.from(envelopeRefresh.authTag),
    };
    const updates: Array<{ sql: string; valores: unknown[] }> = [];
    // Fake completo: leitura via pool.query; UPDATE via transação (connect),
    // com rowCount=1 exigido pelo contrato refreshOauthAccessToken.
    const transacao = {
      release(): void {},
      async query(sql: string, valores?: unknown[]) {
        if (sql.includes("UPDATE oauth_connection")) {
          updates.push({ sql, valores: valores ?? [] });
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      },
    };
    const pool = {
      async query(_sql: string) {
        return { rows: [linha] };
      },
      async connect() {
        return transacao;
      },
    } as never as NodePostgresPool;
    const refreshFake = vi.fn(async () => ({ access_token: "token-renovado-sintetico", expires_in: 3600 }));
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool, portaRefresh: refreshFake });
    const token = await runtime.loadAccessToken();
    expect(token).toBe("token-renovado-sintetico");
    expect(refreshFake).toHaveBeenCalledTimes(1);
    expect(runtime.metricas.refreshes()).toBe(1);
    expect(updates.length).toBe(1);
    // O envelope persistido é CIFRADO: plaintext ausente dos parâmetros UPDATE.
    const valores = updates[0]!.valores as Buffer[];
    const textoValores = valores.map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v))).join("|");
    expect(textoValores).not.toContain("token-renovado-sintetico");
    expect(textoValores).not.toContain("refresh-sintetico");
    // UPDATE params: [id, accountFingerprint, ciphertext, nonce, authTag, keyVersion, expiresAt]
    const nonce = valores[3] as Buffer;
    const tag = valores[4] as Buffer;
    expect(nonce?.byteLength).toBe(12);
    expect(tag?.byteLength).toBe(16);
    expect(valores[5]).toBe(CHAVE_VERSAO);
  });

  it("D — refresh token ausente: erro tipado pré-provider (nunca ambíguo, send=0)", async () => {
    const linha = linhaConexao({ expiraEm: new Date(Date.now() - 60_000), comRefresh: false });
    const pool = poolFake(linha);
    const transportFake = vi.fn();
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never });
    await expect(runtime.loadAccessToken()).rejects.toBeInstanceOf(CampanhaTokenResolutionError);
    const gateway = new GmailMailGateway(transportFake, runtime.loadAccessToken, undefined, { REAL_SEND_ENABLED: "true" });
    await expect(gateway.send({} as never)).rejects.toBeInstanceOf(CampanhaTokenResolutionError);
    expect(transportFake).not.toHaveBeenCalled();
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
  });

  it("E — refresh rejeitado/rede: erro tipado pré-provider, messages.send=0", async () => {
    const caixaTeste = caixa();
    const envelopeRefresh = caixaTeste.seal("refresh-sintetico", "oauth:refresh");
    const linha = {
      ...linhaConexao({ comRefresh: true, expiraEm: new Date(Date.now() - 60_000) }),
      refresh_token_ciphertext: Buffer.from(envelopeRefresh.ciphertext),
      refresh_token_nonce: Buffer.from(envelopeRefresh.nonce),
      refresh_token_auth_tag: Buffer.from(envelopeRefresh.authTag),
    };
    const pool = poolFake(linha);
    const refreshFake = vi.fn(async () => {
      throw new Error("falha de rede sintética do endpoint OAuth");
    });
    const transportFake = vi.fn();
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never, portaRefresh: refreshFake });
    await expect(runtime.loadAccessToken()).rejects.toBeInstanceOf(CampanhaTokenResolutionError);
    const refreshesAposDireta = refreshFake.mock.calls.length;
    // Falha de refresh NÃO é cacheada: cada nova resolução tenta no máximo
    // UMA vez (single-flight) — nunca loop, nunca transport.
    const gateway = new GmailMailGateway(transportFake, runtime.loadAccessToken, undefined, { REAL_SEND_ENABLED: "true" });
    await expect(gateway.send({} as never)).rejects.toBeInstanceOf(CampanhaTokenResolutionError);
    expect(refreshFake.mock.calls.length).toBe(refreshesAposDireta + 1);
    expect(transportFake).not.toHaveBeenCalled();
  });

  it("F — conta persistida ≠ GMAIL_EXPECTED_ACCOUNT: fail closed (decrypt=0, refresh=0)", async () => {
    const { derivarFingerprintContaGmail } = await import("@integra-correios/mail");
    const { HmacSha256Fingerprinter } = await import("@integra-correios/persistence");
    const fpEsperada = derivarFingerprintContaGmail(new HmacSha256Fingerprinter(CHAVE_FP), CONTA_ESPERADA);
    const fpDivergente = derivarFingerprintContaGmail(new HmacSha256Fingerprinter(CHAVE_FP), "outra.conta@exemplo.test");
    expect(fpDivergente).not.toBe(fpEsperada);
    const pool = poolFake(undefined); // consulta PELA conta esperada não encontra a divergente
    const refreshFake = vi.fn(async () => ({ access_token: "novo", expires_in: 3600 }));
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never, portaRefresh: refreshFake });
    await expect(runtime.loadAccessToken()).resolves.toBeUndefined();
    expect(String((pool.parametros[0] as unknown[])[0])).toBe(fpEsperada);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(refreshFake).not.toHaveBeenCalled();
  });

  it("G — conexão revogada: fail closed (decrypt=0, refresh=0, send=0)", async () => {
    const pool = poolFake(undefined); // loadGmailConnection filtra revogada_em IS NULL
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never });
    await expect(runtime.loadAccessToken()).resolves.toBeUndefined();
    expect(pool.consultas[0]).toContain("revogada_em IS NULL");
    expect(runtime.metricas.descriptografias()).toBe(0);
  });

  it("I — falha de decrypt/refresh lança erro tipado sanitizado (sem token na mensagem)", async () => {
    const linha = linhaConexao({}); // envelope inválido por construção (decrypt deve falhar)
    const pool = poolFake(linha);
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool: pool as never });
    try {
      await runtime.loadAccessToken();
      expect.unreachable("deveria ter falhado");
    } catch (error) {
      expect(error).toBeInstanceOf(CampanhaTokenResolutionError);
      expect((error as Error).message).not.toContain("token-valido-sintetico");
      expect((error as Error).message).not.toContain("Bearer");
    }
  });

  it("sanidade da fixture: credencial sintética em formato de token (nunca segredo real)", () => {
    const credencial = "Op_abcdefghijklmnopqrstuvwxyz0123456789" + createHash("sha256").update("canary").digest("base64url").slice(0, 24);
    expect(credencial).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });
});
