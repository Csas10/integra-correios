import { describe, expect, it } from "vitest";
import { handleResendWebhook } from "./resend.js";

describe("endpoint de webhook Resend", () => {
  it("rejeita métodos diferentes de POST sem inicializar o provedor", async () => {
    const response = await handleResendWebhook(
      new Request("https://homologacao.example.invalid/api/webhooks/resend", { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
