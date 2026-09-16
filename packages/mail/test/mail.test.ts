import { describe, expect, it } from "vitest";
import { DisabledMailGateway, MailProviderNaoConfiguradoError, renderPfConfirmationMail } from "../src/index.js";

describe("contratos de comunicação PF", () => {
  it("renderiza o template versionado com escape HTML", () => {
    const message = renderPfConfirmationMail({
      confirmationId: "confirmation-test-001",
      professionalId: "PF|TESTE-001",
      recipient: "teste@example.invalid",
      professionalName: "Pessoa <Teste>",
      replyTo: "carteiras@instituicao.example",
      confirmationPath: "/confirma/token-sintetico",
    });

    expect(message.templateVersion).toBe("pf-confirmation-v1");
    expect(message.idempotencyKey).toBe("pf-confirmation:confirmation-test-001");
    expect(message.htmlBody).toContain("Pessoa &lt;Teste&gt;");
    expect(message.htmlBody).not.toContain("Pessoa <Teste>");
    expect(message.to).toBe("teste@example.invalid");
  });

  it("mantém adapters sem rede explícitos até configuração autorizada", async () => {
    const gateway = new DisabledMailGateway("RESEND");
    await expect(gateway.send({
      idempotencyKey: "test-key",
      confirmationId: "confirmation-test-001",
      to: "teste@example.invalid",
      replyTo: "carteiras@instituicao.example",
      subject: "Teste",
      textBody: "Teste",
      htmlBody: "<p>Teste</p>",
      templateVersion: "test-v1",
    })).rejects.toBeInstanceOf(MailProviderNaoConfiguradoError);
  });
});
