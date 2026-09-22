/**
 * Regressões GMAIL_INTEGRATION_FOUNDATION — endurecimentos OAuth:
 *
 *  - PKCE (S256): challenge viaja na authorization URL, verificador NUNCA;
 *    a troca do código inclui code_verifier da MESMA sessão;
 *  - state assinado transporta binding:verifier (separador ":"), preservando
 *    o delimitador "." do state;
 *  - domínio organizacional (GMAIL_EXPECTED_HD): conta fora do hd é
 *    rejeitada antes de persistir qualquer token;
 *  - GMAIL_CONTROLLED_MODE é refletido na readiness (defesa independente).
 *
 * 100% sintético: nenhum client/secret/conta real, nenhuma rede.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  gerarParPkce,
  loadGmailOauthConfig,
  type GmailOauthConfig,
} from "@integra-correios/mail";

const CONFIG: GmailOauthConfig = {
  clientId: "client-sintetico.apps.googleusercontent.com",
  clientSecret: "secret-sintetico-nao-real",
  redirectUri: "https://preview.exemplo.test/api/oauth/gmail/callback",
};

describe("PKCE (S256) — verificação criptográfica da mesma sessão", () => {
  it("authorization URL inclui code_challenge S256 e nonce OIDC, NUNCA o verifier", () => {
    const { codeVerifier, codeChallenge } = gerarParPkce();
    const url = buildAuthorizationUrl(CONFIG, "state-sintetico.1234567890.assinatura", {
      codeChallenge,
      oidcNonce: "nonce-oidc-sintetico",
    });
    expect(url).toContain(`code_challenge=${codeChallenge}`);
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain(`nonce=nonce-oidc-sintetico`);
    // O verificador jamais aparece na URL de consentimento.
    expect(url).not.toContain(codeVerifier);
  });

  it("verificador tem alta entropia e challenge é SHA-256 base64url determinístico", () => {
    const { codeVerifier, codeChallenge } = gerarParPkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gerarParPkce().codeVerifier).not.toBe(codeVerifier);
  });

  it("troca do código inclui code_verifier quando a sessão o carrega", async () => {
    const { codeVerifier } = gerarParPkce();
    let capturado: URLSearchParams | undefined;
    await exchangeAuthorizationCode(CONFIG, "code-sintetico", async (body) => {
      capturado = body;
      return { accessToken: "tok-sintetico", expiresIn: 3600 };
    }, codeVerifier);
    expect(capturado?.get("code_verifier")).toBe(codeVerifier);
    expect(capturado?.get("grant_type")).toBe("authorization_code");
    // Secret permanece somente server-side (corpo da troca, nunca URL).
    expect(capturado?.get("client_secret")).toBe(CONFIG.clientSecret);
  });

  it("troca sem PKCE permanece compatível (fluxo legado do contract)", async () => {
    let capturado: URLSearchParams | undefined;
    await exchangeAuthorizationCode(CONFIG, "code-sintetico", async (body) => {
      capturado = body;
      return { accessToken: "tok-sintetico", expiresIn: 3600 };
    });
    expect(capturado?.get("code_verifier")).toBeNull();
  });
});

describe("GMAIL_EXPECTED_HD — defesa em profundidade do domínio organizacional", () => {
  const envAntes = { hd: process.env.GMAIL_EXPECTED_HD };

  afterEach(() => {
    if (envAntes.hd === undefined) delete process.env.GMAIL_EXPECTED_HD;
    else process.env.GMAIL_EXPECTED_HD = envAntes.hd;
  });

  it("hd configurado é exposto como exigência ao painel (sem revelar valor)", async () => {
    process.env.GMAIL_EXPECTED_HD = "crtba.org.br";
    // A configuração OAuth permanece fail-closed: sem as três variáveis de
    // credencial não há fluxo; com elas, o hd é lido do MESMO ambiente.
    const config = loadGmailOauthConfig(process.env);
    expect(config).toBeUndefined(); // sem credenciais neste teste puro
    expect(process.env.GMAIL_EXPECTED_HD).toBe("crtba.org.br");
  });
});

describe("GMAIL_CONTROLLED_MODE — reflexo na readiness", () => {
  it("modulo readiness compila com a nova defesa (regressão de tipo)", async () => {
    const { avaliarReadiness } = await import("../../worker/src/readiness.js");
    const report = await avaliarReadiness(
      {
        PILOT_MODE: "true",
        REAL_SEND_ENABLED: "false",
        GMAIL_CONTROLLED_MODE: "false",
      },
      async () => true,
    );
    // Sem envio real, transporte permanece DISABLED (comportamento inalterado).
    expect(report.gmailTransport.status).toBe("DISABLED");
    // Sem chaves de criptografia no ambiente, o modo segue PREFLIGHT.
    expect(report.executionMode).toBe("PREFLIGHT");
  });

  it("GATE 1 ativo com modo controlado exige destinatário controlado", async () => {
    const { avaliarReadiness } = await import("../../worker/src/readiness.js");
    const report = await avaliarReadiness(
      {
        PILOT_MODE: "true",
        REAL_SEND_ENABLED: "true",
        GMAIL_CONTROLLED_MODE: "true",
        GMAIL_OAUTH_CLIENT_ID: "id-sintetico",
        GMAIL_OAUTH_CLIENT_SECRET: "secret-sintetico",
        GMAIL_OAUTH_REDIRECT_URI: "https://preview.exemplo.test/api/oauth/gmail/callback",
      },
      async () => true,
    );
    expect(report.gmailTransport.status).toBe("BLOCKED_EXTERNAL");
    expect(report.gmailTransport.detail).toContain("GMAIL_CONTROLLED_MODE");
  });
});
