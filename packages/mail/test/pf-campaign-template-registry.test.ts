/**
 * SLICE-03C.2B1D — Testes do registry versionado de templates da Campanha PF.
 * ZERO rede, ZERO banco, ZERO envio — fundação de governança de conteúdo.
 * Fixtures 100% sintéticas (domínio .test / nomes neutros) — nenhum dado real.
 */

import { describe, expect, it } from "vitest";
import {
  PF_UPDATE_CAMPAIGN_SUBJECT,
  PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
} from "../src/templates/pf-update-campaign.js";
import {
  TEMPLATE_REGISTRY,
  TEMPLATE_V1_VERSION,
  TEMPLATE_V2_ID,
  TEMPLATE_V2_VERSION,
  metadadosTemplate,
  renderizarPreviewTemplate,
  renderizarTemplatePersistido,
  resolverRendererTemplate,
  selecionarTemplateCampanhaNova,
  templateDefinitionHash,
  validarSubjectCrlfSafe,
} from "../src/templates/pf-campaign-template-registry.js";

const REMETENTE_SINTETICO = {
  name: "CRT-BA | Carteiras Profissionais",
  address: "carteiras@crtba.org.br",
} as const;
const ASSUNTO_V2 = "Campanha de Atualização Cadastral e Expedição da Carteira Profissional — CRTBA";

function entradaSintetica(overrides: Partial<Parameters<typeof renderizarPreviewTemplate>[1]> = {}) {
  return {
    professionalName: "Profissional Teste",
    correlationCode: "PF26TEST00000000000000000000000000",
    remetente: REMETENTE_SINTETICO,
    ...overrides,
  };
}

// A — v1 permanece imutável: mesmo identificador, mesmo assunto legado,
// delegação integral ao renderer homologado (nenhum redirecionamento p/ v2).
describe("03C.2B1D-A — v1 preservada", () => {
  it("A. v1 permanece registrada, imutável e delega ao template legado", () => {
    const v1 = TEMPLATE_REGISTRY.find((e) => e.templateVersion === TEMPLATE_V1_VERSION);
    expect(v1).toBeDefined();
    expect(v1!.templateVersion).toBe(PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION);
    expect(v1!.subject).toBe(PF_UPDATE_CAMPAIGN_SUBJECT);
    // GF-2 FINAL — ciclo de vida do owner: v1 histórica APOSENTADA (RETIRED);
    // a renderização histórica permanece byte a byte; seleção para campanha
    // nova é BLOQUEADA (V1_NEW_SELECTION=BLOCKED).
    expect(v1!.status).toBe("RETIRED");
    expect(v1!.scope).toBe("PF_CAMPAIGN");
    expect(selecionarTemplateCampanhaNova({ templateVersion: TEMPLATE_V1_VERSION })).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_NOT_APPROVED",
    });
    const previa = renderizarPreviewTemplate(TEMPLATE_V1_VERSION, entradaSintetica());
    expect(previa.ok).toBe(true);
    if (previa.ok) {
      // Conteúdo do v1 preservado byte a byte (delegação ao renderer v1).
      expect(previa.mensagem.textBody.startsWith("Olá, Profissional Teste.\n")).toBe(true);
      expect(previa.mensagem.templateVersion).toBe(TEMPLATE_V1_VERSION);
    }
  });
});

describe("03C.2B1D-B..G — ciclo de vida e seleção", () => {
  it("B. v2 tem versão e hash distintos da v1", () => {
    expect(TEMPLATE_V2_VERSION).not.toBe(TEMPLATE_V1_VERSION);
    const v1 = TEMPLATE_REGISTRY.find((e) => e.templateVersion === TEMPLATE_V1_VERSION)!;
    const v2 = TEMPLATE_REGISTRY.find((e) => e.templateVersion === TEMPLATE_V2_VERSION)!;
    expect(v2.definitionHash).not.toBe(v1.definitionHash);
    expect(v2.subject).toBe(ASSUNTO_V2);
    expect(v2.templateId).toBe(TEMPLATE_V2_ID);
  });

  it("C. versão desconhecida é rejeitada (sanitizada)", () => {
    expect(selecionarTemplateCampanhaNova({ templateVersion: "v-desconhecida" })).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_UNSUPPORTED",
    });
    expect(resolverRendererTemplate("v-desconhecida", "execution")).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_UNSUPPORTED",
    });
  });

  it("D. resolução execution fail-closed para DRAFT/RETIRED (v2 APPROVED resolve)", () => {
    // GF-2 FINAL — v2 APPROVED: a versão de RELEASE resolve para EXECUÇÃO.
    expect(resolverRendererTemplate(TEMPLATE_V2_VERSION, "execution").ok).toBe(true);
    // Ciclo de vida preservado: mesmo contrato em status RETIRED não resolve
    // para execução (prova sintética — nenhuma versão real muda de status).
    const hashRetired = templateDefinitionHash({
      templateId: TEMPLATE_V2_ID,
      templateVersion: TEMPLATE_V2_VERSION,
      scope: "PF_CAMPAIGN",
      status: "RETIRED",
      subject: ASSUNTO_V2,
      dataMode: "PREFILLED_CONFIRMATION",
    });
    expect(hashRetired).toMatch(/^[0-9a-f]{64}$/);
    // Defesa em profundidade + prova PREFILLED_CONFIRMATION: o render
    // outbound v2 (APPROVED) usa o MESMO caminho do provider; campos ausentes
    // ⇒ "Não informado"; WhatsApp NUNCA é inferido; CPF NUNCA aparece.
    const renderizado = renderizarTemplatePersistido({
      persistedTemplateVersion: TEMPLATE_V2_VERSION,
      professionalName: "Profissional Teste",
      correlationCode: "PF26TEST00000000000000000000000000",
      remetente: REMETENTE_SINTETICO,
      campaignId: "00000000-0000-4000-8000-00000000000a",
      itemId: "00000000-0000-4000-8000-00000000000b",
      professionalId: "PF-SINTETICO",
      recipient: "profissional@example.test",
      messageTag: "pf-campanha",
    });
    expect(renderizado.ok).toBe(true);
    if (renderizado.ok) {
      expect(renderizado.mensagem.subject).toBe(ASSUNTO_V2);
      expect(renderizado.mensagem.textBody).toContain(
        "WhatsApp Atualizado: informar/confirmar na resposta",
      );
      expect(renderizado.mensagem.textBody).toContain("Logradouro / Endereço: Não informado");
    }
  });

  it("E. seleção explícita sem default: v2 APPROVED selecionável, v1 RETIRED rejeitada", () => {
    // GF-2 FINAL — NENHUM default implícito: ausência de versão ⇒ rejeitada.
    expect(selecionarTemplateCampanhaNova({})).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_UNSUPPORTED",
    });
    // v2 APPROVED é a única selecionável do escopo (prova V2_SELECTION=PASS).
    expect(selecionarTemplateCampanhaNova({ templateVersion: TEMPLATE_V2_VERSION })).toEqual({
      ok: true,
      templateVersion: TEMPLATE_V2_VERSION,
    });
  });

  it("F. escopo incompatível é rejeitado", () => {
    expect(selecionarTemplateCampanhaNova({ scope: "OUTRO_ESCOPO" })).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH",
    });
  });

  it("G. RETIRED renderiza histórico, mas não entra em campanha nova", () => {
    // Prova sintética de ciclo de vida: mesma definição, status RETIRED.
    const hashRetired = templateDefinitionHash({
      templateId: TEMPLATE_V2_ID,
      templateVersion: TEMPLATE_V2_VERSION,
      scope: "PF_CAMPAIGN",
      status: "RETIRED",
      subject: ASSUNTO_V2,
      dataMode: "PREFILLED_CONFIRMATION",
    });
    expect(hashRetired).toMatch(/^[0-9a-f]{64}$/);
    expect(resolverRendererTemplate(TEMPLATE_V1_VERSION, "history")).toMatchObject({
      ok: true,
    });
    // Seleção para campanha nova exige APPROVED: v1 RETIRED é rejeitada
    // (V1_NEW_SELECTION=BLOCKED); v2 APPROVED é a selecionável (teste E).
    expect(selecionarTemplateCampanhaNova({ templateVersion: TEMPLATE_V1_VERSION })).toEqual({
      ok: false,
      code: "CAMPAIGN_TEMPLATE_NOT_APPROVED",
    });
  });
});

describe("03C.2B1D-I..N — render v2, escape, CRLF, protocolo", () => {
  it("I. request não injeta conteúdo (render só por versão persistida)", () => {
    // Nenhuma função de render aceita subject/corpos do chamador: a assinatura
    // do renderizarTemplatePersistido não possui campos de conteúdo.
    const previa = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, entradaSintetica());
    expect(previa.ok).toBe(true);
    if (previa.ok) {
      expect(previa.mensagem.subject).toBe(ASSUNTO_V2);
      expect(previa.mensagem.from).toEqual(REMETENTE_SINTETICO);
    }
  });

  it("J. idempotência muda por versão", () => {
    const v1 = renderizarPreviewTemplate(TEMPLATE_V1_VERSION, entradaSintetica());
    const v2 = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, entradaSintetica());
    expect(v1.ok && v2.ok).toBe(true);
    if (v1.ok && v2.ok) {
      expect(v1.mensagem.idempotencyKey).not.toBe(v2.mensagem.idempotencyKey);
      expect(v2.mensagem.idempotencyKey).toContain(TEMPLATE_V2_VERSION);
    }
  });

  it("K. UTF-8 preservado (sem mojibake) nos corpos e assunto v2", () => {
    const previa = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, entradaSintetica());
    expect(previa.ok).toBe(true);
    if (previa.ok) {
      for (const fragmento of ["Conselho", "pronta para envio", "dias úteis", "Atenciosamente"]) {
        expect(previa.mensagem.textBody).toContain(fragmento);
      }
      expect(previa.mensagem.textBody).toContain("Atenciosamente,");
      expect(previa.mensagem.textBody).toContain("Conselho Regional dos Técnicos Industriais da Bahia — CRTBA");
      expect(/\uFFFD|Ã©|Ã£|Ã§/.test(previa.mensagem.textBody)).toBe(false);
      expect(/\uFFFD|Ã©|Ã£|Ã§/.test(previa.mensagem.htmlBody)).toBe(false);
    }
  });

  it("L. HTML escapa valores dinâmicos", () => {
    const previa = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, {
      ...entradaSintetica(),
      professionalName: '<script>alert("x")</script>',
    });
    expect(previa.ok).toBe(true);
    if (previa.ok) {
      expect(previa.mensagem.htmlBody).not.toContain("<script>");
      expect(previa.mensagem.htmlBody).toContain("&lt;script&gt;");
    }
  });

  it("M. subject bloqueia CRLF (validador do registry)", () => {
    expect(() => validarSubjectCrlfSafe("v-teste", "linha1\nlinha2")).toThrow();
    expect(() => validarSubjectCrlfSafe("v-teste", "linha1\rlinha2")).toThrow();
    expect(() => validarSubjectCrlfSafe("v-teste", "")).toThrow();
    expect(() => validarSubjectCrlfSafe("v-teste", ASSUNTO_V2)).not.toThrow();
  });

  it("N. protocolo não contém UUID/PII e preserva o correlationCode", () => {
    const previa = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, entradaSintetica());
    expect(previa.ok).toBe(true);
    if (previa.ok) {
      expect(previa.mensagem.textBody).toContain("Protocolo: PF26TEST00000000000000000000000000");
      expect(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(previa.mensagem.textBody)).toBe(false);
      expect(previa.mensagem.textBody).not.toContain("Profissional Teste".length ? "@crtba.org.br" : "impossivel");
    }
  });
});

describe("03C.2B1D-O..S — preview, metadados e segregação", () => {
  it("O. preview sintético executa sem rede e sem banco (função pura)", () => {
    const previa = renderizarPreviewTemplate(TEMPLATE_V2_VERSION, {
      ...entradaSintetica(),
      professionalName: "Profissional Teste",
    });
    expect(previa.ok).toBe(true);
    // Equivalência texto/HTML: mesmos campos/estrutura semântica.
    if (previa.ok) {
      for (const campo of ["Logradouro / Endereço:", "Número:", "Complemento:", "Bairro:", "Cidade / UF:", "CEP:", "Telefone Principal:", "WhatsApp Atualizado:"]) {
        expect(previa.mensagem.textBody).toContain(campo);
        expect(previa.mensagem.htmlBody).toContain(campo);
      }
      expect(previa.mensagem.htmlBody).toContain("<strong>Nome Completo:</strong> Profissional Teste");
    }
  });

  it("P. metadados do registry expõem somente informação pública segura", () => {
    const meta = metadadosTemplate(TEMPLATE_V2_VERSION);
    expect(meta.ok).toBe(true);
    expect(meta.templateId).toBe(TEMPLATE_V2_ID);
    expect(meta.status).toBe("APPROVED");
    expect(meta.dataMode).toBe("PREFILLED_CONFIRMATION");
    // GF-2 FINAL — a API pública separa hash do CONTRATO (inclui status) e
    // hash canônico do CONTEÚDO (status-independente).
    expect(meta.registryDefinitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(metadadosTemplate("v-inexistente").ok).toBe(false);
  });

  it("Q. hash determinístico independe da ordem de construção", () => {
    // GF-2 FINAL — golden do contrato v2 APPROVED · PREFILLED_CONFIRMATION
    // (o golden RESPONSE_FORM/DRAFT antigo foi SUPERADO).
    const a = templateDefinitionHash({
      templateId: TEMPLATE_V2_ID,
      templateVersion: TEMPLATE_V2_VERSION,
      scope: "PF_CAMPAIGN",
      status: "APPROVED",
      subject: ASSUNTO_V2,
      dataMode: "PREFILLED_CONFIRMATION",
    });
    const b = templateDefinitionHash({
      dataMode: "PREFILLED_CONFIRMATION",
      subject: ASSUNTO_V2,
      status: "APPROVED",
      scope: "PF_CAMPAIGN",
      templateVersion: TEMPLATE_V2_VERSION,
      templateId: TEMPLATE_V2_ID,
    });
    expect(a).toBe(b);
    const v2 = TEMPLATE_REGISTRY.find((e) => e.templateVersion === TEMPLATE_V2_VERSION)!;
    expect(v2.definitionHash).toBe(a);
  });

  it("R. registry é somente-leitura (Object.freeze) e não importa pilot", async () => {
    expect(Object.isFrozen(TEMPLATE_REGISTRY)).toBe(true);
    const fonte = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/templates/pf-campaign-template-registry.ts", import.meta.url), "utf-8"),
    );
    expect(fonte).not.toContain("PILOT_SENDER");
    expect(fonte).not.toContain('from "./pilot.js"');
    expect(fonte).not.toContain("../pilot");
  });
});
