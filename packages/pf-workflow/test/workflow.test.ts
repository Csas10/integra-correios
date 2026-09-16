import { describe, expect, it } from "vitest";
import type { MailGateway, OutboundMail } from "@integra-correios/mail";
import {
  assertAptoParaPrePostagem,
  criarProfissionalPf,
  PfConfirmationWorkflow,
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
  const workflow = new PfConfirmationWorkflow({
    mail,
    tokens: new FakeTokenService(),
    clock: () => new Date("2026-09-16T00:00:00.000Z"),
    confirmationTtlMs: 60_000,
  });
  const initial: PfWorkflowState = {
    professional: criarProfissionalPf("TESTE-001", ORIGINAL),
    audit: [],
  };
  return { mail, workflow, initial };
}

describe("workflow de confirmação cadastral PF", () => {
  it("executa o fluxo sintético até APTO_PREPOSTAGEM", async () => {
    const { mail, workflow, initial } = criarCenario();
    const triaged = workflow.triage(initial, true);
    const prepared = workflow.prepareEmail(triaged);
    const sent = await workflow.sendEmail(prepared);

    expect(sent.state.professional.status).toBe("AGUARDANDO_CONFIRMACAO");
    expect(sent.state.confirmation?.tokenHash).toBe("hash-opaque-digest");
    expect(JSON.stringify(sent.state)).not.toContain("token-sintetico");
    expect(mail.sent[0]?.templateVersion).toBe("pf-confirmation-v1");

    const updated: PfCadastreSnapshot = {
      ...ORIGINAL,
      telefone: "0000000001",
      endereco: { ...ORIGINAL.endereco, cep: "87654-321" },
    };
    const confirmed = await workflow.submitConfirmation(sent.state, "token-sintetico", {
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
    await expect(workflow.submitConfirmation(sent.state, "token-incorreto", { decision: "CONFIRMAR" }))
      .rejects.toThrow("Token inválido");
  });

  it("mantém pendência quando a alteração cadastral é inválida", async () => {
    const { workflow, initial } = criarCenario();
    const sent = await workflow.sendEmail(workflow.prepareEmail(workflow.triage(initial, true)));
    const confirmed = await workflow.submitConfirmation(sent.state, "token-sintetico", {
      decision: "ATUALIZAR",
      snapshot: { ...ORIGINAL, endereco: { ...ORIGINAL.endereco, cep: "000" } },
    });
    expect(workflow.validateForPrePostagem(confirmed).professional.status).toBe("PENDENCIA_CADASTRAL");
  });
});
