/**
 * GF-2 CORRETIVO §6 — GOLDEN DURÁVEL (versionado no repositório).
 * O fixture `fixtures/pf-campaign-golden-v2.json` é 100% sintético (nome
 * fictício, endereço fictício, domínio .test, correlationCode fixo sem PII,
 * nenhum UUID operacional, nenhum dado dos XLSX de referência) e é comparado
 * INTEGRALMENTE contra a API pública REAL do registry — nunca um helper
 * privado fabricando a expectativa:
 *   templateId · templateVersion · status · scope · dataMode · subject ·
 *   textBody (bytes UTF-8) · htmlBody (bytes UTF-8) · metadata pública ·
 *   templateContentHash · templateDefinitionHash.
 * Determinístico: ZERO Date/random/env/rede. Detecta QUALQUER alteração
 * futura de conteúdo do template v2 (mojibake incluído).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  metadadosTemplate,
  renderizarPreviewTemplate,
} from "../src/templates/pf-campaign-template-registry.js";

interface GoldenFixture {
  readonly goldenVersion: number;
  readonly sintetico: boolean;
  readonly nota: string;
  readonly renderInput: Parameters<typeof renderizarPreviewTemplate>[1];
  readonly templateId: string;
  readonly templateVersion: string;
  readonly status: string;
  readonly scope: string;
  readonly dataMode: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly metadata: {
    readonly publicMetadata: Record<string, unknown>;
    readonly templateContentHash: string;
    readonly templateDefinitionHash: string;
  };
}

const FIXTURE_PATH = new URL("./golden/pf-campaign-golden-v2.json", import.meta.url);
const GOLDEN = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFixture;

function renderAtual() {
  const previa = renderizarPreviewTemplate(GOLDEN.templateVersion, GOLDEN.renderInput);
  if (!previa.ok) throw new Error(`render do golden falhou: ${previa.code}`);
  return previa.mensagem;
}

describe("GF2_CORRETIVO — DURABLE GOLDEN (v2, fixture versionada no repo)", () => {
  it("DURABLE_GOLDEN_TRACKED: fixture existe, é sintética e versionada", () => {
    expect(GOLDEN.sintetico).toBe(true);
    expect(GOLDEN.goldenVersion).toBe(1);
    expect(GOLDEN.templateVersion).toBe("pf-expedicao-carteira-2026-v2");
  });

  it("GOLDEN_EXACT_SUBJECT: assunto integral via API pública real", () => {
    const mensagem = renderAtual();
    expect(mensagem.subject).toBe(GOLDEN.subject);
    expect(mensagem.subject).toBe(
      "Campanha de Atualização Cadastral e Expedição da Carteira Profissional — CRTBA",
    );
  });

  it("GOLDEN_EXACT_TEXT: textBody integral (bytes UTF-8)", () => {
    const mensagem = renderAtual();
    expect(Buffer.from(mensagem.textBody, "utf8").equals(Buffer.from(GOLDEN.textBody, "utf8"))).toBe(
      true,
    );
  });

  it("GOLDEN_EXACT_HTML: htmlBody integral (bytes UTF-8)", () => {
    const mensagem = renderAtual();
    expect(Buffer.from(mensagem.htmlBody, "utf8").equals(Buffer.from(GOLDEN.htmlBody, "utf8"))).toBe(
      true,
    );
  });

  it("GOLDEN_EXACT_METADATA: metadados públicos + contentHash + definitionHash", () => {
    const meta = metadadosTemplate(GOLDEN.templateVersion);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return expect.unreachable();
    expect(meta.templateId).toBe(GOLDEN.templateId);
    expect(meta.templateId).toBe("PF_EXPEDICAO_CARTEIRA");
    expect(meta.status).toBe(GOLDEN.status);
    expect(meta.status).toBe("APPROVED");
    expect(meta.scope).toBe(GOLDEN.scope);
    expect(meta.scope).toBe("PF_CAMPAIGN");
    expect(meta.dataMode).toBe(GOLDEN.dataMode);
    expect(meta.dataMode).toBe("PREFILLED_CONFIRMATION");
    expect(JSON.parse(JSON.stringify(meta.publicMetadata))).toEqual(GOLDEN.metadata.publicMetadata);
    expect(meta.contentHash).toBe(GOLDEN.metadata.templateContentHash);
    expect(meta.registryDefinitionHash).toBe(GOLDEN.metadata.templateDefinitionHash);
  });

  it("GOLDEN_UTF8 + GOLDEN_MOJIBAKE=false: bytes íntegros, sem replacement/Ã-…", () => {
    const mensagem = renderAtual();
    const corpos = [mensagem.textBody, mensagem.htmlBody];
    for (const corpo of corpos) {
      expect(corpo.includes("\uFFFD")).toBe(false);
      // Sequências típicas de dupla codificação (UTF-8 lido como Latin-1).
      expect(corpo).not.toMatch(/Ã[©£§§µ]/);
      // Caracteres institucionais intencionais permanecem presentes.
    }
    expect(mensagem.subject).toContain("—");
    expect(mensagem.textBody).toContain("—");
    // Campos prefilled do fixture aparecem integralmente no texto.
    for (const valor of [
      GOLDEN.renderInput.professionalName,
      GOLDEN.renderInput.exibicao?.logradouro,
      GOLDEN.renderInput.exibicao?.cep,
      GOLDEN.renderInput.exibicao?.telefone,
    ]) {
      expect(mensagem.textBody).toContain(valor as string);
    }
  });

  it("GOLDEN_CONTAINS_REAL_PII: false — nenhum dado real no fixture renderizado", () => {
    const mensagem = renderAtual();
    const corpos = [GOLDEN.subject, mensagem.textBody, mensagem.htmlBody].join("\n");
    // Nenhum CPF formatado; somente domínio .test; nenhum UUID operacional.
    expect(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(corpos)).toBe(false);
    expect(corpos).not.toContain("@gmail.com");
    expect(corpos).not.toContain("@crtba.org.br");
    // Nenhum e-mail é renderizado no corpo do template v2; se algum aparecer
    // no futuro, apenas domínios sintéticos .test são permitidos.
    const emails = corpos.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    for (const email of emails) {
      expect(email.endsWith(".test")).toBe(true);
    }
    expect(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(corpos)).toBe(
      false,
    );
    // Fonte do fixture é sintética por contrato.
    expect(GOLDEN.sintetico).toBe(true);
  });
});
