import { describe, expect, it } from "vitest";
import {
  DestinatarioNaoAutorizadoError,
  InMemoryWebhookEventOwnership,
  loadConfirmationBaseUrl,
  loadHomologationMailPolicy,
  MailHomologationConfigError,
  readResendWebhookHeaders,
  ResendMailGateway,
  ResendWebhookProcessor,
  type OutboundMail,
  type ResendRetrievedEmail,
  type ResendSendInput,
  type ResendTransport,
  type ResendWebhookVerificationInput,
} from "../src/index.js";

const ENV = {
  MAIL_MODE: "homologation",
  MAIL_FROM_NAME: "Carteiras",
  MAIL_FROM_ADDRESS: "notificacoes@example.invalid",
  MAIL_REPLY_TO: "carteiras@example.invalid",
  MAIL_HOMOLOGATION_WHITELIST: "gmail-teste@example.invalid,outlook-teste@example.invalid",
  CONFIRMATION_BASE_URL: "https://homologacao.example.invalid",
} as const;

const MESSAGE: OutboundMail = {
  idempotencyKey: "pf-confirmation:confirmation-test-001:pf-confirmation-v1",
  confirmationId: "confirmation-test-001",
  to: "gmail-teste@example.invalid",
  replyTo: "carteiras@example.invalid",
  subject: "Confirmação cadastral",
  textBody: "Conteúdo sintético",
  htmlBody: "<p>Conteúdo sintético</p>",
  templateVersion: "pf-confirmation-v1",
};

class FakeResendTransport implements ResendTransport {
  readonly sends: { input: ResendSendInput; idempotencyKey: string }[] = [];
  retrieved: ResendRetrievedEmail = { id: "email-test-001", lastEvent: "delivered" };
  webhookPayload: unknown = {
    type: "email.delivered",
    created_at: "2026-09-16T14:00:00.000Z",
    data: { email_id: "email-test-001" },
  };
  verification?: ResendWebhookVerificationInput;

  async send(input: ResendSendInput, idempotencyKey: string): Promise<string> {
    this.sends.push({ input, idempotencyKey });
    return "email-test-001";
  }

  async retrieve(_messageId: string): Promise<ResendRetrievedEmail> {
    return this.retrieved;
  }

  verifyWebhook(input: ResendWebhookVerificationInput): unknown {
    this.verification = input;
    return this.webhookPayload;
  }
}

describe("política de homologação de e-mail", () => {
  it("permanece bloqueada fora do modo homologation", () => {
    expect(() => loadHomologationMailPolicy({ ...ENV, MAIL_MODE: "disabled" }))
      .toThrow(MailHomologationConfigError);
  });

  it("normaliza e limita a whitelist a cinco destinatários", () => {
    const policy = loadHomologationMailPolicy({
      ...ENV,
      MAIL_HOMOLOGATION_WHITELIST: " Gmail-Teste@Example.Invalid ,gmail-teste@example.invalid ",
    });
    expect(policy.allowedRecipients).toEqual(["gmail-teste@example.invalid"]);

    expect(() => loadHomologationMailPolicy({
      ...ENV,
      MAIL_HOMOLOGATION_WHITELIST: Array.from(
        { length: 6 },
        (_, index) => `teste-${index}@example.invalid`,
      ).join(","),
    })).toThrow("Whitelist limitada a 5 destinatários");
  });

  it("aceita somente origem HTTPS fixa", () => {
    expect(loadConfirmationBaseUrl(ENV)).toBe("https://homologacao.example.invalid");
    expect(() => loadConfirmationBaseUrl({
      ...ENV,
      CONFIRMATION_BASE_URL: "https://homologacao.example.invalid/caminho",
    })).toThrow("deve ser uma origem HTTPS");
  });
});

describe("ResendMailGateway de homologação", () => {
  it("envia HTML e texto com Reply-To e idempotência estáveis", async () => {
    const transport = new FakeResendTransport();
    const gateway = new ResendMailGateway(
      loadHomologationMailPolicy(ENV),
      transport,
      () => new Date("2026-09-16T14:00:00.000Z"),
    );

    const first = await gateway.send(MESSAGE);
    const second = await gateway.send(MESSAGE);

    expect(first).toEqual(second);
    expect(transport.sends).toHaveLength(2);
    expect(transport.sends[0]).toMatchObject({
      idempotencyKey: MESSAGE.idempotencyKey,
      input: {
        from: "Carteiras <notificacoes@example.invalid>",
        to: "gmail-teste@example.invalid",
        replyTo: "carteiras@example.invalid",
        text: MESSAGE.textBody,
        html: MESSAGE.htmlBody,
      },
    });
  });

  it("bloqueia destinatário fora da whitelist antes do transporte", async () => {
    const transport = new FakeResendTransport();
    const gateway = new ResendMailGateway(loadHomologationMailPolicy(ENV), transport);

    await expect(gateway.send({ ...MESSAGE, to: "nao-autorizado@example.invalid" }))
      .rejects.toBeInstanceOf(DestinatarioNaoAutorizadoError);
    expect(transport.sends).toHaveLength(0);
  });

  it("converte o status consultado sem expor conteúdo da mensagem", async () => {
    const transport = new FakeResendTransport();
    const gateway = new ResendMailGateway(
      loadHomologationMailPolicy(ENV),
      transport,
      () => new Date("2026-09-16T14:05:00.000Z"),
    );
    await expect(gateway.getStatus("email-test-001")).resolves.toEqual({
      provider: "RESEND",
      messageId: "email-test-001",
      status: "DELIVERED",
      observedAt: "2026-09-16T14:05:00.000Z",
    });
  });
});

describe("webhook Resend", () => {
  it("verifica o corpo bruto e ignora repetição do mesmo svix-id", async () => {
    const transport = new FakeResendTransport();
    const processor = new ResendWebhookProcessor(
      transport,
      "segredo-sintetico",
      new InMemoryWebhookEventOwnership(),
    );
    const headers = {
      id: "event-test-001",
      timestamp: "1789567200",
      signature: "assinatura-sintetica",
    };
    const rawBody = '{"payload":"preservado"}';

    await expect(processor.process(rawBody, headers)).resolves.toEqual({
      eventId: "event-test-001",
      provider: "RESEND",
      messageId: "email-test-001",
      status: "DELIVERED",
      observedAt: "2026-09-16T14:00:00.000Z",
    });
    await expect(processor.process(rawBody, headers)).resolves.toBeUndefined();
    expect(transport.verification).toEqual({
      payload: rawBody,
      headers,
      webhookSecret: "segredo-sintetico",
    });
  });

  it("exige todos os cabeçalhos Svix", () => {
    expect(() => readResendWebhookHeaders(new Headers({ "svix-id": "event-test-001" })))
      .toThrow("Cabeçalhos de assinatura");
  });
});
