import { describe, expect, it } from "vitest";
import {
  extrairReasonGoogle,
  GmailAmbiguousError,
  GmailRateLimitError,
  GmailPermanentPolicyError,
  GmailHttpTransport,
  MailProviderRequestError,
} from "../src/index.js";
import type { OutboundMail } from "../src/index.js";

// FINAL CLOSURE GATE item 3 — classificação correta dos erros do Gmail:
// nem todo 403 é permanente. 100% sintético (fetch falso, sem rede).

const mensagem: OutboundMail = {
  idempotencyKey: "pf-pilot:CONF-GATE",
  confirmationId: "CONF-GATE",
  to: "profissional@exemplo.test",
  replyTo: "carteiras@crtba.org.br",
  subject: "Confirmação cadastral",
  textBody: "linha",
  htmlBody: "<p>linha</p>",
  templateVersion: "pf-pilot-crtba-v1",
};

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

function corpoErroGoogle(reason: string): string {
  return JSON.stringify({ error: { code: 403, errors: [{ reason }], message: "detalhe interno" } });
}

describe("FINAL CLOSURE GATE item 3 — classificação dos erros Gmail", () => {
  it("403 rateLimitExceeded → RATE_LIMITED (retryable)", async () => {
    await comFetchFake(
      async () => new Response(corpoErroGoogle("rateLimitExceeded"), { status: 403 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailRateLimitError);
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(MailProviderRequestError);
      },
    );
  });

  it("403 userRateLimitExceeded → RATE_LIMITED (retryable)", async () => {
    await comFetchFake(
      async () => new Response(corpoErroGoogle("userRateLimitExceeded"), { status: 403 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailRateLimitError);
      },
    );
  });

  it("403 domainPolicy → FAILED_PERMANENT", async () => {
    await comFetchFake(
      async () => new Response(corpoErroGoogle("domainPolicy"), { status: 403 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailPermanentPolicyError);
      },
    );
  });

  it("403 com escopo insuficiente → FAILED_PERMANENT", async () => {
    await comFetchFake(
      async () => new Response(corpoErroGoogle("insufficientPermissions"), { status: 403 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailPermanentPolicyError);
      },
    );
  });

  it("429 → RATE_LIMITED", async () => {
    await comFetchFake(
      async () => new Response("{}", { status: 429 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailRateLimitError);
      },
    );
  });

  it("5xx pós-tentativa → AMBÍGUO (nunca reenvio automático no piloto)", async () => {
    await comFetchFake(
      async () => new Response("{}", { status: 503 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailAmbiguousError);
      },
    );
  });

  it("timeout de rede → AMBÍGUO", async () => {
    await comFetchFake(
      async () => {
        const erro = new Error("The operation was aborted");
        erro.name = "TimeoutError";
        throw erro;
      },
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(GmailAmbiguousError);
      },
    );
  });

  it("401 → AUTH_REQUIRED", async () => {
    await comFetchFake(
      async () => new Response("{}", { status: 401 }),
      async (transporte) => {
        await expect(transporte.send(mensagem, "t")).rejects.toThrow(/401/);
      },
    );
  });

  it("extrairReasonGoogle devolve o reason curto e NUNCA o corpo bruto", async () => {
    const resposta = new Response(corpoErroGoogle("rateLimitExceeded"), { status: 403 });
    const reason = await extrairReasonGoogle(resposta);
    expect(reason).toBe("rateLimitExceeded");
    // O corpo integral NUNCA é propagado — apenas o reason.
    expect(reason).not.toContain("detalhe interno");
  });
});
