import { describe, expect, it } from "vitest";
import type { MailGateway, OutboundMail } from "@integra-correios/mail";
import {
  assertAptoParaPrePostagem,
  createWebTokenService,
  criarProfissionalPf,
  InMemoryConfirmationOwnership,
  PfConfirmationWorkflow,
  validarCadastroPf,
  type PfCadastreSnapshot,
  type PfWorkflowState,
  type TokenPair,
} from "../src/index.js";

function gerarCpf(base: string): string {
  const digits = base.replace(/\D/g, "").slice(0, 9);
  const calculate = (input: string, length: number) => {
    const sum = [...input].reduce(
      (total, digit, index) => total + Number(digit) * (length + 1 - index),
      0,
    );
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  const first = calculate(digits, 9);
  const second = calculate(`${digits}${first}`, 10);
  return `${digits}${first}${second}`;
}

const ORIGINAL: PfCadastreSnapshot = {
  documento: gerarCpf("123456789"),
  nome: "Pessoa Sintética",
  email: "pessoa.sintetica@example.invalid",
  telefone: "0000000000",
  endereco: {
    logradouro: "Rua Sintética",
    numero: "10",
    bairro: "Centro",
    cidade: "Cidade Teste",
    uf: "SP",
    cep: "12345-678",
  },
};

class FakeTokenService {
  readonly pair: TokenPair = { plainToken: "token-sintetico", tokenHash: "hash-opaque-digest" };

  async issue(): Promise<TokenPair> {
    return this.pair;
  }

  async hash(value: string): Promise<string> {
    return value === "token-sintetico" ? this.pair.tokenHash : "hash-invalid";
  }
}

class FakeMailGateway implements MailGateway {
  readonly sent: OutboundMail[] = [];

  async send(message: OutboundMail) {
    this.sent.push(message);
    return {
      provider: "RESEND" as const,
      messageId: "message-sintetico-001",
      acceptedAt: "2026-09-16T00:00:00.000Z",
    };
  }

  async getStatus(messageId: string) {
    return {
      provider: "RESEND" as const,
      messageId,
      status: "ACCEPTED" as const,
      observedAt: "2026-09-16T00:00:00.000Z",
    };
  }
}

function criarCenario() {
  const mail = new FakeMailGateway();
  const confirmations = new InMemoryConfirmationOwnership();
  const workflow = new PfConfirmationWorkflow({
    mail,
    confirmations,
    tokens: new FakeTokenService(),
    confirmationBaseUrl: "https://app.example.invalid",
    clock: () => new Date("2026-09-16T00:00:00.000Z"),
    confirmationTtlMs: 60_000,
  });
  const initial: PfWorkflowState = {
    professional: criarProfissionalPf("TESTE-001", ORIGINAL),
    audit: [],
  };
  return { confirmations, mail, workflow, initial };
}

describe("workflow de confirmação cadastral PF", () => {
  it("executa o fluxo sintético até APTO_PREPOSTAGEM", async () => {
    const { mail, workflow, initial } = criarCenario();
    const triaged = workflow.triage(initial, true);
    const prepared = workflow.prepareEmail(triaged);
    const sent = await workflow.sendEmail(prepared);

    expect(sent.professional.status).toBe("AGUARDANDO_CONFIRMACAO");
    expect(sent.confirmation?.tokenHash).toBe("hash-opaque-digest");
    expect(JSON.stringify(sent)).not.toContain("token-sintetico");
    expect(mail.sent[0]?.templateVersion).toBe("pf-confirmation-v1");
    expect(mail.sent[0]?.textBody).toContain(
      "https://app.example.invalid/confirma/token-sintetico",
    );
    expect(
      sent.audit.slice(-4).map((event) =>
        event.type === "PF_STATUS_CHANGED" ? event.to : event.type,
      ),
    ).toEqual([
      "PF_CONFIRMATION_ISSUED",
      "EMAIL_ENVIADO",
      "PF_COMMUNICATION_ACCEPTED",
      "AGUARDANDO_CONFIRMACAO",
    ]);

    const updated: PfCadastreSnapshot = {
      ...ORIGINAL,
      telefone: "0000000001",
      endereco: { ...ORIGINAL.endereco, cep: "87654-321" },
    };
    const confirmed = await workflow.submitConfirmation(sent, "token-sintetico", {
      decision: "ATUALIZAR",
      snapshot: updated,
    });
    expect(confirmed.professional.status).toBe("CONFIRMADO_COM_ALTERACAO");
    expect(confirmed.professional.original.endereco.cep).toBe("12345-678");
    expect(confirmed.professional.confirmed?.endereco.cep).toBe("87654-321");

    const ready = workflow.validateForPrePostagem(confirmed);
    expect(ready.professional.status).toBe("APTO_PREPOSTAGEM");
    expect(() => assertAptoParaPrePostagem(ready)).not.toThrow();
    expect(ready.audit.map((event) => event.type)).toContain("PF_CONFIRMATION_ISSUED");
    expect(ready.audit.map((event) => event.type)).toContain("PF_COMMUNICATION_ACCEPTED");
  });

  it("bloqueia lote antes do gate e rejeita token inválido", async () => {
    const { workflow, initial } = criarCenario();
    expect(() => assertAptoParaPrePostagem(initial)).toThrow("APTO_PREPOSTAGEM");
    const sent = await workflow.sendEmail(workflow.prepareEmail(workflow.triage(initial, true)));
    await expect(workflow.submitConfirmation(sent, "token-incorreto", { decision: "CONFIRMAR" }))
      .rejects.toThrow("Token inválido");
  });

  it("mantém pendência quando a alteração cadastral é inválida", async () => {
    const { workflow, initial } = criarCenario();
    const sent = await workflow.sendEmail(workflow.prepareEmail(workflow.triage(initial, true)));
    const confirmed = await workflow.submitConfirmation(sent, "token-sintetico", {
      decision: "ATUALIZAR",
      snapshot: { ...ORIGINAL, endereco: { ...ORIGINAL.endereco, cep: "000" } },
    });
    expect(workflow.validateForPrePostagem(confirmed).professional.status).toBe("PENDENCIA_CADASTRAL");
  });

  it("aceita exatamente uma de duas submissões concorrentes no mesmo owner", async () => {
    const { workflow, initial } = criarCenario();
    const state = await workflow.sendEmail(workflow.prepareEmail(workflow.triage(initial, true)));
    const submission = { decision: "CONFIRMAR" as const };

    const results = await Promise.allSettled([
      workflow.submitConfirmation(state, "token-sintetico", submission),
      workflow.submitConfirmation(state, "token-sintetico", submission),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("não expõe estado parcial quando o gateway de e-mail falha", async () => {
    const confirmations = new InMemoryConfirmationOwnership();
    const workflow = new PfConfirmationWorkflow({
      mail: {
        async send() { throw new Error("Falha sintética de envio"); },
        async getStatus() { throw new Error("Indisponível"); },
      },
      confirmations,
      tokens: new FakeTokenService(),
      confirmationBaseUrl: "https://app.example.invalid",
      clock: () => new Date("2026-09-16T00:00:00.000Z"),
      idFactory: () => "confirmation-test-failure",
    });
    const initial: PfWorkflowState = {
      professional: criarProfissionalPf("TESTE-FALHA", ORIGINAL),
      audit: [],
    };
    const prepared = workflow.prepareEmail(workflow.triage(initial, true));

    await expect(workflow.sendEmail(prepared)).rejects.toThrow("Falha sintética de envio");
    await expect(confirmations.consumePending({
      confirmationId: "confirmation-test-failure",
      tokenHash: "hash-opaque-digest",
      usedAt: "2026-09-16T00:00:01.000Z",
    })).resolves.toBeUndefined();
    expect(prepared.professional.status).toBe("EMAIL_PENDENTE");
  });

  it("gera tokens URL-safe com 256 bits de entropia", async () => {
    const tokens = createWebTokenService();
    const token = await tokens.issue();
    expect(token.plainToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await tokens.hash(token.plainToken)).toBe(token.tokenHash);
  });

  it("reutiliza as validações centrais de UF e e-mail", () => {
    expect(validarCadastroPf({ ...ORIGINAL, email: "user@" }).issues).toContain("E-mail inválido");
    expect(validarCadastroPf({
      ...ORIGINAL,
      endereco: { ...ORIGINAL.endereco, uf: "ZZ" },
    }).issues).toContain("UF inválida");
  });

  it("rejeita origem de confirmação sem HTTPS antes do envio", async () => {
    const mail = new FakeMailGateway();
    const workflow = new PfConfirmationWorkflow({
      mail,
      confirmations: new InMemoryConfirmationOwnership(),
      tokens: new FakeTokenService(),
      confirmationBaseUrl: "http://app.example.invalid",
      clock: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    const initial: PfWorkflowState = {
      professional: criarProfissionalPf("TESTE-HTTPS", ORIGINAL),
      audit: [],
    };
    const prepared = workflow.prepareEmail(workflow.triage(initial, true));

    await expect(workflow.sendEmail(prepared)).rejects.toThrow("deve usar HTTPS");
    expect(mail.sent).toHaveLength(0);
  });
});
