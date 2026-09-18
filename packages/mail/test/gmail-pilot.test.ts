import { describe, expect, it } from "vitest";
import {
  GMAIL_SEND_SCOPE,
  GmailMailGateway,
  MailProviderNaoConfiguradoError,
  OauthStateSigner,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  loadGmailOauthConfig,
  oauthStatusFromEnvironment,
  renderPfPilotConfirmationMail,
  PILOT_SENDER,
  PILOT_SUBJECT,
  PF_PILOT_TEMPLATE_VERSION,
} from "../src/index.js";
import type { OutboundMail } from "../src/index.js";

describe("OAuth Gmail — config e state/CSRF", () => {
  it("CONFIGURATION_REQUIRED quando credenciais ausentes", () => {
    expect(loadGmailOauthConfig({})).toBeUndefined();
    expect(oauthStatusFromEnvironment({}, false)).toBe("CONFIGURATION_REQUIRED");
  });

  it("NOT_CONNECTED quando configurado mas não conectado", () => {
    const env = {
      GMAIL_OAUTH_CLIENT_ID: "client",
      GMAIL_OAUTH_CLIENT_SECRET: "secret",
      GMAIL_OAUTH_REDIRECT_URI: "https://app.exemplo.test/oauth/gmail/callback",
    };
    expect(oauthStatusFromEnvironment(env, false)).toBe("NOT_CONNECTED");
    expect(oauthStatusFromEnvironment(env, true)).toBe("CONNECTED");
  });

  it("escopo é somente gmail.send (sem leitura de inbox)", () => {
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
    const url = buildAuthorizationUrl(
      {
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.exemplo.test/cb",
      },
      "state-123",
    );
    expect(url).toContain("scope=" + encodeURIComponent(GMAIL_SEND_SCOPE));
    expect(url).not.toContain("gmail.readonly");
    expect(url).not.toContain("gmail.modify");
    expect(url).toContain("state=state-123");
  });

  it("state assinado: válido dentro do TTL, inválido após expiração", () => {
    const signer = new OauthStateSigner(new Uint8Array(32).fill(7), 60_000);
    const agora = new Date("2026-09-17T12:00:00Z");
    const { state } = signer.issue(agora);
    expect(signer.verify(state, agora)).toBe(true);
    expect(signer.verify(state, new Date(agora.getTime() + 61_000))).toBe(false);
  });

  it("state adulterado ou de outra instalação é rejeitado", () => {
    const signerA = new OauthStateSigner(new Uint8Array(32).fill(7));
    const signerB = new OauthStateSigner(new Uint8Array(32).fill(8));
    const { state } = signerA.issue();
    expect(signerB.verify(state)).toBe(false);
    expect(signerA.verify(`${state}x`)).toBe(false);
    expect(signerA.verify("malformed")).toBe(false);
  });

  it("troca de code envia client_secret somente server-side (transport injetado)", async () => {
    let corpoCapturado: URLSearchParams | undefined;
    const tokens = await exchangeAuthorizationCode(
      { clientId: "cid", clientSecret: "csecret", redirectUri: "https://app/cb" },
      "codigo- authorization",
      async (body) => {
        corpoCapturado = body;
        return { accessToken: "at", expiresIn: 3600, refreshToken: "rt" };
      },
    );
    expect(tokens.accessToken).toBe("at");
    expect(corpoCapturado?.get("client_secret")).toBe("csecret");
    expect(corpoCapturado?.get("grant_type")).toBe("authorization_code");
  });
});

describe("GmailMailGateway — fail-closed REAL_SEND_ENABLED", () => {
  const mensagem: OutboundMail = {
    idempotencyKey: "k",
    confirmationId: "c",
    to: "alguem@exemplo.test",
    replyTo: PILOT_SENDER.address,
    subject: PILOT_SUBJECT,
    textBody: "t",
    htmlBody: "<p>t</p>",
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
  };

  it("REAL_SEND_ENABLED=false bloqueia mesmo com transport e token", async () => {
    const gateway = new GmailMailGateway(
      async () => ({ provider: "GMAIL", messageId: "x", acceptedAt: new Date().toISOString() }),
      async () => "token",
      () => new Date(),
      { REAL_SEND_ENABLED: "false" },
    );
    await expect(gateway.send(mensagem)).rejects.toThrow(MailProviderNaoConfiguradoError);
    expect(gateway.realSendEnabled).toBe(false);
  });

  it("flag ausente (default) é bloqueado — fail-closed", async () => {
    const gateway = new GmailMailGateway(
      async () => ({ provider: "GMAIL", messageId: "x", acceptedAt: new Date().toISOString() }),
      async () => "token",
      () => new Date(),
      {},
    );
    await expect(gateway.send(mensagem)).rejects.toThrow(/REAL_SEND_ENABLED/);
  });

  it("REAL_SEND_ENABLED=true sem token → OAUTH_NOT_CONNECTED", async () => {
    const gateway = new GmailMailGateway(
      async () => ({ provider: "GMAIL", messageId: "x", acceptedAt: new Date().toISOString() }),
      async () => undefined,
      () => new Date(),
      { REAL_SEND_ENABLED: "true" },
    );
    await expect(gateway.send(mensagem)).rejects.toThrow(/não conectada/);
  });

  it("REAL_SEND_ENABLED=true com transport+token envia (caminho técnico)", async () => {
    const gateway = new GmailMailGateway(
      async (msg, token) => {
        expect(token).toBe("token");
        return { provider: "GMAIL", messageId: `gmail-${msg.confirmationId}`, acceptedAt: new Date().toISOString() };
      },
      async () => "token",
      () => new Date(),
      { REAL_SEND_ENABLED: "true" },
    );
    const receipt = await gateway.send(mensagem);
    expect(receipt.provider).toBe("GMAIL");
    expect(receipt.messageId).toBe(`gmail-${mensagem.confirmationId}`);
  });
});

describe("Template institucional do piloto", () => {
  it("versão, remetente e assunto institucionais fixos", () => {
    expect(PF_PILOT_TEMPLATE_VERSION).toBe("pf-pilot-crtba-v1");
    expect(PILOT_SENDER.address).toBe("carteiras@crtba.org.br");
    expect(PILOT_SUBJECT).toBe("Confirmação de dados para envio da Carteira Profissional");
  });

  it("corpo contém CONFIRMAR/ATUALIZAR e NUNCA o CPF", () => {
    const mensagem = renderPfPilotConfirmationMail({
      confirmationId: "conf-1",
      recipient: "profissional@exemplo.test",
      professionalName: "Profissional Sintetico",
      enderecoApresentado: "Rua Teste, 100 — Salvador/BA",
      telefone: "***9999",
      whatsapp: "***8888",
      confirmUrl: "https://app.exemplo.test/confirma/tok-conf",
      updateUrl: "https://app.exemplo.test/confirma/tok-upd",
    });
    expect(mensagem.htmlBody).toContain("CONFIRMAR DADOS");
    expect(mensagem.htmlBody).toContain("ATUALIZAR DADOS");
    expect(mensagem.htmlBody).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    expect(mensagem.textBody).not.toMatch(/\d{11}/);
    expect(mensagem.templateVersion).toBe("pf-pilot-crtba-v1");
    expect(mensagem.idempotencyKey).toContain("conf-1");
  });

  it("WhatsApp omitido não quebra o template", () => {
    const mensagem = renderPfPilotConfirmationMail({
      confirmationId: "conf-2",
      recipient: "profissional@exemplo.test",
      professionalName: "Nome",
      enderecoApresentado: "Rua",
      telefone: "***0000",
      confirmUrl: "https://app/c1",
      updateUrl: "https://app/c2",
    });
    expect(mensagem.htmlBody).not.toContain("WhatsApp:");
    expect(mensagem.textBody).not.toContain("WhatsApp:");
  });
});
