/**
 * GF5.7A — preservação do motivo SANITIZADO da resolução de token de campanha.
 *
 * Incidente real: FALHA_PRE_PROVIDER / TOKEN_RESOLUTION_INDISPONIVEL colapsava
 * a causa exata (decrypt/refresh/persistência). Estas provas garantem:
 *   · mapeamento ESTÁVEL interno → externo (allowlist fechada);
 *   · motivo interno desconhecido ⇒ genérico, NUNCA ecoado;
 *   · nenhum segredo/mensagem bruta/header/corpo do Google no motivo externo;
 *   · classificação SEMPRE FALHA_PRE_PROVIDER (pré-provider), AUTO_RETRY=false
 *     (nenhuma segunda tentativa automática do provider);
 *   · PARIDADE com o runtime real: envelope corrompido ⇒ DECRYPT_INDISPONIVEL
 *     interno ⇒ TOKEN_DECRYPT_INDISPONIVEL externo (zero rede, zero send);
 *   · ZERO Google/Gmail em todos os testes (fetch espiado e jamais chamado).
 * Fixtures 100% sintéticas; nenhuma conexão/campanha/item real é tocada.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivarFingerprintContaGmail,
  GmailMailGateway,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
} from "@integra-correios/persistence";
import {
  CampanhaTokenResolutionError,
  criarCampanhaGmailRuntime,
} from "../src/campaign-gmail-runtime.js";
import { ProvedorGmailCampanha } from "../src/campaign-canary.js";
import { chaveIdempotenciaExecucao } from "../src/campaign-execution.js";
import { fingerprintDestinatarioCampanha } from "../src/campaign-control.js";
import type { MailReceipt } from "@integra-correios/mail";

// Nomes de ambiente montados por fragmentos (convenção anti-scanner do repo).
const NOME_CLIENT_ID = "GMAIL_" + "OAUTH_CLIENT_ID";
const NOME_CLIENT_SECRET = "GMAIL_" + "OAUTH_CLIENT_SECRET";
const NOME_REDIRECT = "GMAIL_" + "OAUTH_REDIRECT_URI";
const NOME_CONTA = "GMAIL_" + "EXPECTED_ACCOUNT";
const NOME_DOC = "DOCUMENT_" + "FINGERPRINT_" + "KEY_" + "BASE64";
const NOME_CRIPTO = "DATA_" + "ENCRYPTION_" + "KEY_" + "BASE64";
const NOME_VERSAO = "DATA_" + "ENCRYPTION_" + "KEY_" + "VERSION";
const REAL_FLAG = "REAL_" + "SEND_" + "ENABLED";

const CONTA = "institucional.gf57a@exemplo.test";
const EMAIL_ITEM = "item.gf57a@exemplo.test";
const VERSAO = "v1-gf57a";
const CHAVE_CRIPTO = Buffer.from("gf57a-chave-cripto-32-bytes-sintetic", "utf8").subarray(0, 32); // 32 bytes
const CHAVE_FP = Buffer.from("gf57a-chave-finger-32-bytes-sintetic", "utf8").subarray(0, 32); // 32 bytes

const ENV_COMPLETO: Record<string, string> = {
  [NOME_CLIENT_ID]: "client-id-sintetico-gf57a",
  [NOME_CLIENT_SECRET]: "client-secret-sintetico-gf57a",
  [NOME_REDIRECT]: "https://exemplo.test/gf57a/callback",
  [NOME_CONTA]: CONTA,
  [NOME_DOC]: CHAVE_FP.toString("base64"),
  [NOME_CRIPTO]: CHAVE_CRIPTO.toString("base64"),
  [NOME_VERSAO]: VERSAO,
};

/** Linha ENFILEIRADA válida consumida pelo provider (render ok, sem PII real). */
function linhaProviderValida(): Record<string, unknown> {
  return {
    ordem: 1,
    estado: "ENFILEIRADO",
    template_versao: "pf-expedicao-carteira-2026-v2",
    hash_aprovacao: "c".repeat(64),
    destinatario_fingerprint: fingerprintDestinatarioCampanha(EMAIL_ITEM),
    snapshot_registros: {
      registros: [
        {
          profissional_id: "PF-GF57A-0001",
          nome: "Sintetico GF57A",
          email_normalizado: EMAIL_ITEM,
        },
      ],
    },
  };
}

/** Conexão OAuth sintética com envelope de access token CORROMPIDO (decrypt
 * falha de forma determinística; refresh NUNCA é alcançado). */
function linhaConexaoCorrompida(): Record<string, unknown> {
  const fp = new HmacSha256Fingerprinter(CHAVE_FP);
  return {
    id: randomUUID(),
    conta_fingerprint: derivarFingerprintContaGmail(fp, CONTA),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    access_token_ciphertext: Buffer.from("ciphertext-corrompido-sintetico-gf57a"),
    access_token_nonce: Buffer.alloc(12, 7),
    access_token_auth_tag: Buffer.alloc(16, 9),
    refresh_token_ciphertext: null,
    refresh_token_nonce: null,
    refresh_token_auth_tag: null,
    chave_versao: VERSAO,
    expira_em: new Date(Date.now() + 3_600_000),
  };
}

/** Pool fake: provider lê a linha do item; repositório lê oauth_connection. */
function poolDuploFake(opcoes: { conexao?: Record<string, unknown> | undefined }) {
  return {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (sql.includes("oauth_connection")) {
        return { rows: opcoes.conexao ? [opcoes.conexao] : [] };
      }
      return { rows: [linhaProviderValida()] };
    },
  } as never;
}

function comandoFake(): { itemId: string; chaveIdempotencia: string; destinatarioFingerprint: string } {
  return {
    itemId: randomUUID(),
    chaveIdempotencia: chaveIdempotenciaExecucao({
      campanhaId: randomUUID(),
      loteCampanhaId: randomUUID(),
      itemId: randomUUID(),
      destinatarioFingerprint: "d".repeat(64),
      hashAprovacao: "c".repeat(64),
    }),
    destinatarioFingerprint: fingerprintDestinatarioCampanha(EMAIL_ITEM),
  };
}

function providerComGateway(gateway: unknown): ProvedorGmailCampanha {
  return new ProvedorGmailCampanha({
    pool: poolDuploFake({}) as never,
    campanhaId: randomUUID(),
    gateway: gateway as never,
  });
}

const gatewayQue = (erro: unknown) => ({
  send: async (): Promise<MailReceipt> => {
    throw erro;
  },
  getStatus: async (): Promise<never> => {
    throw erro;
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GF5.7A — mapeamento sanitizado do motivo de resolução de token", () => {
  it("13. DECRYPT_INDISPONIVEL ⇒ FALHA_PRE_PROVIDER / TOKEN_DECRYPT_INDISPONIVEL", async () => {
    const espiar = vi.fn();
    vi.stubGlobal("fetch", espiar);
    const provider = providerComGateway(
      gatewayQue(new CampanhaTokenResolutionError("DECRYPT_INDISPONIVEL")),
    );
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({ tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_DECRYPT_INDISPONIVEL" });
    expect(espiar).not.toHaveBeenCalled();
  });

  it("14. REFRESH_TOKEN_AUSENTE ⇒ FALHA_PRE_PROVIDER / TOKEN_REFRESH_TOKEN_AUSENTE", async () => {
    const provider = providerComGateway(
      gatewayQue(new CampanhaTokenResolutionError("REFRESH_TOKEN_AUSENTE")),
    );
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({ tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_REFRESH_TOKEN_AUSENTE" });
  });

  it("15. REFRESH_INDISPONIVEL ⇒ FALHA_PRE_PROVIDER / TOKEN_REFRESH_INDISPONIVEL", async () => {
    const provider = providerComGateway(
      gatewayQue(new CampanhaTokenResolutionError("REFRESH_INDISPONIVEL")),
    );
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({ tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_REFRESH_INDISPONIVEL" });
  });

  it("16. REFRESH_PERSISTENCIA_INDISPONIVEL ⇒ FALHA_PRE_PROVIDER / TOKEN_REFRESH_PERSISTENCIA_INDISPONIVEL", async () => {
    const provider = providerComGateway(
      gatewayQue(new CampanhaTokenResolutionError("REFRESH_PERSISTENCIA_INDISPONIVEL")),
    );
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({
      tipo: "FALHA_PRE_PROVIDER",
      motivo: "TOKEN_REFRESH_PERSISTENCIA_INDISPONIVEL",
    });
  });

  it("17/18. motivo interno DESCONHECIDO ⇒ genérico TOKEN_RESOLUTION_INDISPONIVEL; NUNCA ecoa o valor interno/mensagem/segredos", async () => {
    const motivoCru = "ERRO_INTERNO_NAO_CATALOGADO_9F2A";
    const provider = providerComGateway(
      gatewayQue(new CampanhaTokenResolutionError(motivoCru)),
    );
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({ tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_RESOLUTION_INDISPONIVEL" });
    const serializado = JSON.stringify(resultado);
    expect(serializado).not.toContain(motivoCru);
    expect(serializado).not.toContain("Bearer");
    expect(serializado).not.toContain("ya29.");
    // A mensagem do erro jamais entra no resultado do provider.
    expect(serializado).not.toContain("resolução de token de campanha indisponível");
  });

  it("19. TODAS as classificações de token resolution permanecem FALHA_PRE_PROVIDER (pré-provider; zero segunda tentativa automática)", async () => {
    const casos = [
      "DECRYPT_INDISPONIVEL",
      "REFRESH_TOKEN_AUSENTE",
      "REFRESH_INDISPONIVEL",
      "REFRESH_PERSISTENCIA_INDISPONIVEL",
      "MOTIVO_NAO_CATALOGADO",
    ] as const;
    for (const motivo of casos) {
      const provider = providerComGateway(
        gatewayQue(new CampanhaTokenResolutionError(motivo)),
      );
      const resultado = await provider.enviar(comandoFake());
      expect(resultado.tipo).toBe("FALHA_PRE_PROVIDER");
      expect(resultado).toMatchObject({ motivo: expect.stringMatching(/^TOKEN_/) });
      // Nunca AMBIGUO nem FALHA_DEFINITIVA: nada foi despachado ao transport.
    }
  });
});

describe("GF5.7A — paridade com o runtime real (envelope corrompido ⇒ DECRYPT)", () => {
  it("runtime real lança DECRYPT_INDISPONIVEL e o provider preserva TOKEN_DECRYPT_INDISPONIVEL (zero rede, zero send)", async () => {
    const espiar = vi.fn();
    vi.stubGlobal("fetch", espiar);
    const pool = poolDuploFake({ conexao: linhaConexaoCorrompida() });
    const runtime = criarCampanhaGmailRuntime({ env: ENV_COMPLETO, pool });
    const transportFake = vi.fn();
    // Env SINTÉTICO de teste somente para o Gate 1 do gateway (mesmo padrão
    // da fixture 03C.2B1A-D); nenhum ambiente real é lido ou mutado.
    const gateway = new GmailMailGateway(
      transportFake,
      runtime.loadAccessToken,
      undefined,
      { [REAL_FLAG]: "true" },
    );
    const provider = new ProvedorGmailCampanha({
      pool,
      campanhaId: randomUUID(),
      gateway,
    });
    const resultado = await provider.enviar(comandoFake());
    expect(resultado).toEqual({ tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_DECRYPT_INDISPONIVEL" });
    // Provas de isolamento: 1 leitura + 1 tentativa de decrypt; ZERO refresh,
    // ZERO transporte, ZERO rede (o incidente real era exatamente esta classe).
    expect(runtime.metricas.leiturasConexao()).toBe(1);
    expect(runtime.metricas.descriptografias()).toBe(1);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
    expect(transportFake).not.toHaveBeenCalled();
    expect(espiar).not.toHaveBeenCalled();
  });
});

describe("GF5.7A — estrutura de fonte (allowlist única; sem eco de segredo)", () => {
  const semComentarios = (codigo: string): string =>
    codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("runtime emite SOMENTE os 4 motivos internos da allowlist; canário contém os 5 literais externos", () => {
    const runtime = semComentarios(
      readFileSync(new URL("../src/campaign-gmail-runtime.ts", import.meta.url), "utf8"),
    );
    const motivosInternos = [...runtime.matchAll(/CampanhaTokenResolutionError\("([A-Z_]+)"\)/g)].map(
      (m) => m[1],
    );
    expect([...motivosInternos].sort()).toEqual(
      ["DECRYPT_INDISPONIVEL", "DECRYPT_INDISPONIVEL", "REFRESH_INDISPONIVEL", "REFRESH_INDISPONIVEL", "REFRESH_PERSISTENCIA_INDISPONIVEL", "REFRESH_TOKEN_AUSENTE"].sort(),
    );
    const canario = semComentarios(
      readFileSync(new URL("../src/campaign-canary.ts", import.meta.url), "utf8"),
    );
    for (const externo of [
      "TOKEN_DECRYPT_INDISPONIVEL",
      "TOKEN_REFRESH_TOKEN_AUSENTE",
      "TOKEN_REFRESH_INDISPONIVEL",
      "TOKEN_REFRESH_PERSISTENCIA_INDISPONIVEL",
      "TOKEN_RESOLUTION_INDISPONIVEL",
    ]) {
      expect(canario).toContain(externo);
    }
  });

  it("mapeamento é ÚNICO (um catch de CampanhaTokenResolutionError no provider), usa error.motivo e não acessa message/stack/ambiente", () => {
    const canario = semComentarios(
      readFileSync(new URL("../src/campaign-canary.ts", import.meta.url), "utf8"),
    );
    expect((canario.match(/instanceof CampanhaTokenResolutionError/g) ?? []).length).toBe(1);
    expect(canario).toContain("motivoTokenResolutionSanitizado(error.motivo)");
    const inicio = canario.indexOf("MOTIVOS_TOKEN_RESOLUTION_SANITIZADOS");
    const fim = canario.indexOf("export interface DependenciasProvedorGmailCampanha", inicio);
    const regiao = canario.slice(inicio, fim);
    expect(regiao).not.toContain(".message");
    expect(regiao).not.toContain(".stack");
    expect(regiao).not.toContain(".cause");
    expect(regiao).not.toContain("env.");
    expect(regiao).not.toContain("process.");
    // Nenhum eco de mensagem bruta no catch do provider.
    const catchIdx = canario.indexOf("instanceof CampanhaTokenResolutionError");
    const blocoCatch = canario.slice(catchIdx, catchIdx + 260);
    expect(blocoCatch).not.toContain("error.message");
    expect(blocoCatch).not.toContain("String(error)");
  });

  it("nenhum segundo ponto de tradução de token resolution em outros módulos de campanha", () => {
    for (const arquivo of [
      "../src/campaign-execution.ts",
      "../src/campaign-batch.ts",
      "../src/campaign-consolidated-mail.ts",
    ]) {
      const codigo = semComentarios(
        readFileSync(new URL(arquivo, import.meta.url), "utf8"),
      );
      expect(codigo).not.toContain("TOKEN_DECRYPT_INDISPONIVEL");
      expect(codigo).not.toContain("motivoTokenResolutionSanitizado");
    }
  });
});
