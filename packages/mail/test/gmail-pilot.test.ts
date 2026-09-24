import { describe, expect, it } from "vitest";
import {
  GMAIL_SEND_SCOPE,
  GmailHttpTransport,
  GmailMailGateway,
  MailProviderNaoConfiguradoError,
  MailProviderRequestError,
  OauthStateSigner,
  buildAuthorizationUrl,
  composeMimeMessage,
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

describe("Transporte Gmail real — MIME e messages.send (sem rede)", () => {
  const mensagem: OutboundMail = {
    idempotencyKey: "k",
    confirmationId: "conf-mime-1",
    to: "profissional@exemplo.test",
    replyTo: PILOT_SENDER.address,
    subject: PILOT_SUBJECT,
    textBody: "corpo texto",
    htmlBody: "<p>corpo html</p>",
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
  };

  it("composição MIME: multipart/alternative com From/Reply-To/To/Subject e ambas as partes", () => {
    const mime = composeMimeMessage(mensagem);
    expect(mime).toContain(`From: ${PILOT_SENDER.name} <${PILOT_SENDER.address}>`);
    expect(mime).toContain(`Reply-To: ${PILOT_SENDER.address}`);
    expect(mime).toContain(`To: profissional@exemplo.test`);
    const subjectHeader = mime.split("\r\n").find((line) => line.startsWith("Subject: "));
    expect(subjectHeader).toMatch(/^Subject: =\?UTF-8\?B\?/);
    const subjectMatch = /^Subject: =\?UTF-8\?B\?([^?]+)\?=$/.exec(subjectHeader ?? "");
    expect(Buffer.from(subjectMatch?.[1] ?? "", "base64").toString("utf8")).toBe(PILOT_SUBJECT);
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    expect(mime).toContain("corpo texto");
    expect(mime).toContain("<p>corpo html</p>");
    expect(mime).toContain(`X-Integra-Template-Version: ${PF_PILOT_TEMPLATE_VERSION}`);
  });

  it("header injection (CRLF) em destinatário/assunto é rejeitada", () => {
    expect(() =>
      composeMimeMessage({ ...mensagem, to: "a@exemplo.test\r\nBcc: vítima@exemplo.test" }),
    ).toThrow(/CRLF/);
    expect(() =>
      composeMimeMessage({ ...mensagem, subject: `Assunto\nBcc: x@exemplo.test` }),
    ).toThrow(/CRLF/);
  });

  it("assunto com caracteres fora do range é codificado em RFC 2047", () => {
    const mime = composeMimeMessage({ ...mensagem, subject: "Confirmação de dados ✓" });
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  async function comFetchFake(
    implementacao: (url: string, init: RequestInit) => Promise<Response>,
    acao: (transporte: GmailHttpTransport) => Promise<unknown>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = implementacao as typeof fetch;
    try {
      await acao(new GmailHttpTransport());
    } finally {
      globalThis.fetch = original;
    }
  }

  it("messages.send: corpo base64url, Bearer token e receipt com id do Gmail", async () => {
    let capturado: { url: string; init: RequestInit } | undefined;
    await comFetchFake(
      async (url, init) => {
        capturado = { url, init };
        return new Response(JSON.stringify({ id: "gmail-msg-123", threadId: "thr-9" }), {
          status: 200,
        });
      },
      async (transporte) => {
        const receipt = await transporte.send(mensagem, "token-teste");
        expect(receipt.provider).toBe("GMAIL");
        expect(receipt.messageId).toBe("gmail-msg-123");
      },
    );
    expect(capturado?.url).toContain("gmail.googleapis.com");
    expect((capturado?.init.headers as Record<string, string>).authorization).toBe("Bearer token-teste");
    const corpo = JSON.parse(capturado!.init.body as string) as { raw: string };
    const mime = Buffer.from(corpo.raw, "base64url").toString("utf8");
    expect(mime).toContain(`To: profissional@exemplo.test`);
  });

  it("HTTP 4xx/5xx e rede caída viram erro sanitizado (sem corpo da resposta)", async () => {
    await comFetchFake(
      async () => new Response("{\"erro\":\"detalhe interno\"}", { status: 403 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(MailProviderRequestError);
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(/403/);
      },
    );
    await comFetchFake(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(/rede/);
      },
    );
  });

  it("refresh de token usa grant_type=refresh_token e devolve access_token", async () => {
    let corpoCapturado: URLSearchParams | undefined;
    await comFetchFake(
      async (_url, init) => {
        corpoCapturado = new URLSearchParams(init.body as string);
        return new Response(
          JSON.stringify({ access_token: "novo-token", expires_in: 3600 }),
          { status: 200 },
        );
      },
      async (transporte) => {
        const tokens = await transporte.refreshAccessToken(
          { clientId: "cid", clientSecret: "csecret", redirectUri: "https://app/cb" },
          "refresh-sintetico",
        );
        expect(tokens.access_token).toBe("novo-token");
        expect(tokens.expires_in).toBe(3600);
      },
    );
    expect(corpoCapturado?.get("grant_type")).toBe("refresh_token");
    expect(corpoCapturado?.get("client_secret")).toBe("csecret");
    expect(corpoCapturado?.get("refresh_token")).toBe("refresh-sintetico");
  });

  it("gateway completo com transporte real: REAL_SEND_ENABLED=false segue bloqueando", async () => {
    const transporte = new GmailHttpTransport();
    const gateway = new GmailMailGateway(
      (msg, token) => transporte.send(msg, token),
      async () => "token",
      () => new Date(),
      { REAL_SEND_ENABLED: "false" },
    );
    await expect(gateway.send(mensagem)).rejects.toThrow(MailProviderNaoConfiguradoError);
  });
});
