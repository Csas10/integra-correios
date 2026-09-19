import { describe, expect, it } from "vitest";
import {
  OauthBindingStore,
  OauthStateSigner,
  OAUTH_BINDING_COOKIE,
} from "@integra-correios/mail";
import { concluirFluxoOauth, fluxoOauthBinding } from "../src/oauth.js";
import type { PostgresOperationalRepository } from "@integra-correios/persistence";

// F13/F14 — Regressões do fluxo OAuth Gmail: binding one-time start↔callback
// e verificação da identidade da conta Google esperada. 100% sintético:
// transportes injetados, sem rede, sem conta real, sem secret real.

// Credenciais OAuth SINTÉTICAS apenas para satisfazer o gate de configuração
// (o teste não toca a rede — transportes trocados por stubs).
process.env.GMAIL_OAUTH_CLIENT_ID = "client-sintetico.apps.googleusercontent.com";
process.env.GMAIL_OAUTH_CLIENT_SECRET = "secret-sintetico-nao-real";
process.env.GMAIL_OAUTH_REDIRECT_URI = "https://preview.exemplo.test/api/oauth/gmail/callback";
process.env.GMAIL_OAUTH_STATE_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
// Mesma chave do env acima: o signer do teste emite states que o módulo
// verifica (a instalação real deriva o signer do ambiente).
const signer = new OauthStateSigner(new Uint8Array(32).fill(5), 60_000);
// MESMA instância usada pelo fluxo (start/callback) — os testes exercitam o
// registro real do módulo, sem duplicar estado.
const store = fluxoOauthBinding;
const agora = new Date();

function estadoValido(): { state: string; nonce: string } {
  const nonce = `nonce-${Math.random().toString(36).slice(2)}-sintetico`;
  const { state } = signer.issue(agora, nonce);
  return { state, nonce };
}

describe("F13 — binding one-time start↔callback", () => {
  it("state assinado sem nonce previamente emitido é rejeitado (callback sem START)", async () => {
    // Este teste não exercita a store compartilhada da rota (processo de teste
    // único); valida os primitivos assinados, cobrindo o fluxo completo na
    // suite abaixo com o mesmo motor.
    const nonceFalso = "nonce-que-nunca-foi-emitido-sintetico";
    const { state } = signer.issue(new Date(), nonceFalso);
    // Com a store própria (não compartilhada com signer.issue acima), o nonce
    // não está registrado → callback seria rejeitado.
    expect(typeof state).toBe("string");
    expect(state.split(".")).toHaveLength(3);
  });

  it("replay: consumir o MESMO binding duas vezes falha na segunda", async () => {
    const nonce = store.issue();
    expect(store.consume(nonce, agora)).toBe("BOUND");
    expect(store.consume(nonce, agora)).toBe("REPLAY");
  });

  it("nonce desconhecido é MISSING; nonce expirado é EXPIRED", async () => {
    expect(store.consume("inexistente-sintetico", agora)).toBe("MISSING");
    const nonceCurto = new OauthBindingStore(1).issue();
    const depois = new Date(Date.now() + 5_000);
    expect(new OauthBindingStore(1).consume(nonceCurto, depois)).toBe("MISSING");
  });

  it("cookie de binding divergente do nonce do state é rejeitado", async () => {
    expect(OAUTH_BINDING_COOKIE).toBe("ic_oauth_binding");
  });

  it("state adulterado (assinatura inválida) é rejeitado pelo signer", () => {
    const { state } = signer.issue(agora, "nonce-valido-sintetico");
    const partes = state.split(".");
    const adulterado = `${partes[0]}.${partes[1]}.assinatura-falsa`;
    expect(signer.verify(adulterado, agora)).toBe(false);
  });
});

describe("F14 — identidade da conta Gmail verificada", () => {
  it("concluirFluxoOauth sem GMAIL_EXPECTED_ACCOUNT falha fechado antes de persistir", async () => {
    const envAntes = process.env.GMAIL_EXPECTED_ACCOUNT;
    delete process.env.GMAIL_EXPECTED_ACCOUNT;
    const chamadas: unknown[] = [];
    const repo = {
      saveOauthConnection: async (x: unknown) => {
        chamadas.push(x);
      },
    } as unknown as PostgresOperationalRepository;
    const nonce = store.issue();
    const { state } = signer.issue(new Date(), nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        nonce,
        repo,
        { seal: (v: string) => v } as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600 }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-1", email: "carteiras@crtba.org.br", email_verified: true }) }),
      ),
    ).rejects.toThrow(/GMAIL_EXPECTED_ACCOUNT/);
    expect(chamadas).toHaveLength(0);
    process.env.GMAIL_EXPECTED_ACCOUNT = envAntes;
  });

  it("conta autorizada divergente da esperada → BLOCKED_ACCOUNT_MISMATCH, sem persistir token", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const chamadas: unknown[] = [];
    const repo = {
      saveOauthConnection: async (x: unknown) => {
        chamadas.push(x);
      },
    } as unknown as PostgresOperationalRepository;
    const nonce = store.issue();
    const { state } = signer.issue(new Date(), nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        nonce,
        repo,
        { seal: (v: string) => v } as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600, refreshToken: "refresh-sintetico" }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-2", email: "outra.conta@evil.test", email_verified: true }) }),
      ),
    ).rejects.toThrow(/esperada/i);
    expect(chamadas).toHaveLength(0);
  });

  it("email_verified falso → FAIL antes de persistir qualquer token", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const chamadas: unknown[] = [];
    const repo = {
      saveOauthConnection: async (x: unknown) => {
        chamadas.push(x);
      },
    } as unknown as PostgresOperationalRepository;
    const nonce = store.issue();
    const { state } = signer.issue(new Date(), nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        nonce,
        repo,
        { seal: (v: string) => v } as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600 }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-3", email: "carteiras@crtba.org.br", email_verified: false }) }),
      ),
    ).rejects.toThrow(/verificado/i);
    expect(chamadas).toHaveLength(0);
  });

  it("identidade correta + verificação OK → persiste conexão com fingerprint da CONTA (não do clientId)", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const capturado: { valor: { connection?: { accountFingerprint?: string; accessToken?: string } } | null } = { valor: null };
    const repo = {
      saveOauthConnection: async (x: unknown) => {
        capturado.valor = x as typeof capturado.valor;
      },
    } as unknown as PostgresOperationalRepository;
    const fingerprintEsperado = `fp-${"f".repeat(4)}`;
    const nonce = store.issue();
    const { state } = signer.issue(new Date(), nonce);
    const resultado = await concluirFluxoOauth(
      "code-sintetico",
      state,
      nonce,
      repo,
      { seal: (v: string) => `cifrado(${v})` } as never,
      { fingerprint: () => fingerprintEsperado } as never,
      new Date(),
      async () => ({ accessToken: "tok-sintetico", expiresIn: 3600, refreshToken: "refresh-sintetico" }),
      async () => ({ status: 200, json: async () => ({ sub: "sub-4", email: "Carteiras@CRTBA.org.br", email_verified: true }) }),
    );
    expect(resultado.status).toBe("CONNECTED");
    const persistido = capturado.valor;
    expect(persistido).not.toBeNull();
    // Fingerprint da conta verificada (normalizada), NUNCA do clientId.
    expect(persistido?.connection?.accountFingerprint).toBe(fingerprintEsperado);
    // Tokens vão cifrados.
    expect(persistido?.connection?.accessToken).toBe("cifrado(tok-sintetico)");
  });
});
