/**
 * GF-2 FINAL — provas do contrato PREFILLED_CONFIRMATION:
 * · projeção integral dos campos de exibição no snapshot JSONB (sem
 *   segunda cópia raw, sem migration);
 * · normalização de apresentação (whitespace → espaço único; controle ⇒
 *   rejeitado; S/N e zeros significativos preservados);
 * · renderer v2 preenche campos do snapshot, NUNCA infere WhatsApp e
 *   NUNCA renderiza CPF;
 * · contentHash: status-independente e sensível ao conteúdo (sem fonte de
 *   função e sem render sintético).
 * ZERO rede, ZERO banco, ZERO envio.
 */

import { describe, expect, it } from "vitest";
import {
  metadadosTemplate,
  renderizarTemplatePersistido,
  templateContentHash,
  TEMPLATE_V2_VERSION,
} from "@integra-correios/mail";
import {
  hashAprovacaoCampanha,
  normalizarExibicaoRegistroCampanha,
  snapshotCampanha,
  type CampaignPersistRegistro,
} from "../src/campaigns.js";
import { normalizarCampoExibicaoCampanha } from "../src/campaign-import.js";
import { readFileSync } from "node:fs";

const REGISTRO_APTO: CampaignPersistRegistro = {
  profissional_id: "00000000-0000-4000-8000-0000000000a1",
  nome: "Profissional Teste",
  email_normalizado: "profissional.teste@exemplo.test",
  status_validacao: "APTO",
};

describe("GF2_FINAL — normalização de apresentação (contrato do owner)", () => {
  it("whitespace sequencial (CR/LF/TAB) → espaço único; trim; vazio ⇒ ausente", () => {
    expect(normalizarCampoExibicaoCampanha("  Rua   Teste\r\n  ")).toBe("Rua Teste");
    expect(normalizarCampoExibicaoCampanha("A\tB\t\tC")).toBe("A B C");
    expect(normalizarCampoExibicaoCampanha("   ")).toBeUndefined();
    expect(normalizarCampoExibicaoCampanha(undefined)).toBeUndefined();
  });

  it("preserva semântica: S/N, zeros significativos e hífens não são alterados", () => {
    expect(normalizarCampoExibicaoCampanha("S/N")).toBe("S/N");
    expect(normalizarCampoExibicaoCampanha("00000-000")).toBe("00000-000");
    expect(normalizarCampoExibicaoCampanha("007")).toBe("007");
  });

  it("normalizarExibicaoRegistroCampanha: confina chaves, rejeita controle e tipos", () => {
    const ok = normalizarExibicaoRegistroCampanha({
      logradouro: " Rua   Teste ",
      numero: "123",
      cep: "00000-000",
      extra: "IGNORADO",
    });
    expect(ok).toEqual({ logradouro: "Rua Teste", numero: "123", cep: "00000-000" });
    expect(normalizarExibicaoRegistroCampanha({ bairro: "   " })).toBeUndefined();
    expect(normalizarExibicaoRegistroCampanha(undefined)).toBeUndefined();
    expect(() =>
      normalizarExibicaoRegistroCampanha({ cidade: "Salvador\u0007" }),
    ).toThrow();
    expect(() => normalizarExibicaoRegistroCampanha({ uf: 42 })).toThrow();
    expect(() => normalizarExibicaoRegistroCampanha([["x"]])).toThrow();
  });
});

describe("GF2_FINAL — projeção do snapshot (sem migration, sem cópia raw)", () => {
  const snapshot = snapshotCampanha({
    fingerprintArquivo: "a".repeat(64),
    templateVersao: TEMPLATE_V2_VERSION,
    templateContentHash: "c".repeat(64),
    registros: [
      {
        ...REGISTRO_APTO,
        exibicao: {
          telefone: "(00) 00000-0000",
          cep: "00000-000",
          logradouro: "Rua Teste",
          numero: "123",
          complemento: "S/N",
          bairro: "Bairro Teste",
          cidade: "Salvador",
          uf: "BA",
        },
      },
      REGISTRO_APTO,
    ],
    decisoes: [],
  });

  it("SNAPSHOT_HAS_{PHONE,CEP,STREET,NUMBER,COMPLEMENT,NEIGHBORHOOD,CITY,UF} = true", () => {
    const registro = snapshot.registros[0]!;
    expect(registro.exibicao).toBeDefined();
    expect(registro.exibicao?.telefone).toBe("(00) 00000-0000");
    expect(registro.exibicao?.cep).toBe("00000-000");
    expect(registro.exibicao?.logradouro).toBe("Rua Teste");
    expect(registro.exibicao?.numero).toBe("123");
    expect(registro.exibicao?.complemento).toBe("S/N");
    expect(registro.exibicao?.bairro).toBe("Bairro Teste");
    expect(registro.exibicao?.cidade).toBe("Salvador");
    expect(registro.exibicao?.uf).toBe("BA");
  });

  it("nome e e-mail permanecem no snapshot; registros sem exibicao seguem válidos", () => {
    expect(snapshot.registros[0]!.nome).toBe("Profissional Teste");
    expect(snapshot.registros[0]!.email_normalizado).toBe("profissional.teste@exemplo.test");
    expect(snapshot.registros[1]!.exibicao).toBeUndefined();
  });

  // GF-2 CORRETIVO — a expectativa anterior ("hash não varia com campos de
  // exibição") estava ERRADA e foi INVERTIDA: no contrato V2 os campos
  // PREFILLED FAZEM PARTE do conteúdo aprovado (autorização vinculada ao que
  // renderiza). Determinismo permanece: mesma entrada ⇒ mesmo hash.
  it("hash V2 VARIA com campos de exibição (SNAPSHOT_HASH_BINDS_PREFILLED_FIELDS)", () => {
    const com = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...REGISTRO_APTO, exibicao: { cep: "00000-000" } }],
    });
    const sem = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [REGISTRO_APTO],
    });
    expect(com).not.toBe(sem);
    // Determinismo: mesma entrada ⇒ mesmo hash.
    expect(com).toBe(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: "c".repeat(64),
        registros: [{ ...REGISTRO_APTO, exibicao: { cep: "00000-000" } }],
      }),
    );
  });

  it("cada campo renderizado altera o hash V2 (EACH_RENDERED_FIELD_CHANGES_HASH)", () => {
    const contentHash = "c".repeat(64);
    const hashBase = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        {
          ...REGISTRO_APTO,
          exibicao: {
            telefone: "(00) 00000-0000",
            cep: "00000-000",
            logradouro: "Rua Teste",
            numero: "123",
            complemento: "S/N",
            bairro: "Bairro Teste",
            cidade: "Salvador",
            uf: "BA",
          },
        },
      ],
    });
    const alteracoes: readonly (readonly [string, string])[] = [
      ["telefone", "(00) 00000-9999"],
      ["cep", "11111-111"],
      ["logradouro", "Avenida Diferente"],
      ["numero", "456"],
      ["complemento", "AP 12"],
      ["bairro", "Outro Bairro"],
      ["cidade", "Feira de Santana"],
      ["uf", "PE"],
    ];
    for (const [campo, valor] of alteracoes) {
      const modificado = hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: contentHash,
        registros: [
          {
            ...REGISTRO_APTO,
            nome: campo === "nome" ? "Outra Pessoa" : REGISTRO_APTO.nome,
            exibicao: {
              telefone: "(00) 00000-0000",
              cep: "00000-000",
              logradouro: "Rua Teste",
              numero: "123",
              complemento: "S/N",
              bairro: "Bairro Teste",
              cidade: "Salvador",
              uf: "BA",
              [campo]: valor,
            },
          },
        ],
      });
      expect(modificado).not.toBe(hashBase);
    }
    // nome e email_normalizado também vinculam a autorização.
    expect(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: contentHash,
        registros: [{ ...REGISTRO_APTO, nome: "Outra Pessoa" }],
      }),
    ).not.toBe(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: contentHash,
        registros: [REGISTRO_APTO],
      }),
    );
    // templateVersion e templateContentHash também vinculam.
    expect(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: "pf-expedicao-carteira-2026-v3",
        templateContentHash: contentHash,
        registros: [REGISTRO_APTO],
      }),
    ).not.toBe(hashBase);
    expect(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: "d".repeat(64),
        registros: [REGISTRO_APTO],
      }),
    ).not.toBe(hashBase);
  });

  it("ordem incidental de propriedades e null canônico não mudam o hash V2", () => {
    const contentHash = "c".repeat(64);
    const entrada = {
      contrato: "CAMPANHA_APROVACAO_V2" as const,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        {
          ...REGISTRO_APTO,
          exibicao: {
            telefone: "(00) 00000-0000",
            cep: "00000-000",
            logradouro: "Rua Teste",
            numero: "123",
            complemento: "S/N",
            bairro: "Bairro Teste",
            cidade: "Salvador",
            uf: "BA",
          },
        },
      ],
    };
    const direto = hashAprovacaoCampanha(entrada);
    const outraOrdem = hashAprovacaoCampanha({
      ...entrada,
      registros: [
        {
          ...REGISTRO_APTO,
          exibicao: {
            uf: "BA",
            cidade: "Salvador",
            bairro: "Bairro Teste",
            complemento: "S/N",
            numero: "123",
            logradouro: "Rua Teste",
            cep: "00000-000",
            telefone: "(00) 00000-0000",
          },
        },
      ],
    });
    expect(direto).toBe(outraOrdem);
    // null canônico: registro SEM exibicao e com exibicao vazia ⇒ mesmo hash.
    const semExibicao = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [REGISTRO_APTO],
    });
    const exibicaoVazia = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        {
          ...REGISTRO_APTO,
          ...(normalizarExibicaoRegistroCampanha({ cep: " " }) === undefined
            ? {}
            : { exibicao: normalizarExibicaoRegistroCampanha({ cep: " " }) }),
        },
      ],
    });
    expect(exibicaoVazia).toBe(semExibicao);
  });
});

describe("GF2_FINAL — renderer v2 PREFILLED_CONFIRMATION", () => {
  const renderizado = renderizarTemplatePersistido({
    persistedTemplateVersion: TEMPLATE_V2_VERSION,
    professionalName: "Profissional Teste",
    correlationCode: "PF26TEST00000000000000000000000000",
    exibicao: {
      logradouro: "Rua Teste",
      numero: "123",
      cep: "00000-000",
      telefone: "(00) 00000-0000",
      cidade: "Salvador",
      uf: "BA",
    },
    remetente: { name: "CRT-BA | Carteiras Profissionais", address: "carteiras@crtba.org.br" },
    campaignId: "00000000-0000-4000-8000-00000000000a",
    itemId: "00000000-0000-4000-8000-00000000000b",
    professionalId: "00000000-0000-4000-8000-0000000000c1",
    recipient: "profissional.teste@exemplo.test",
    messageTag: "pf-campanha",
  });

  it("FINAL_GOLDEN_PREFILLED_FIELDS: campos do snapshot aparecem preenchidos", () => {
    expect(renderizado.ok).toBe(true);
    if (!renderizado.ok) return;
    expect(renderizado.mensagem.textBody).toContain("Nome Completo: Profissional Teste");
    expect(renderizado.mensagem.textBody).toContain("Logradouro / Endereço: Rua Teste");
    expect(renderizado.mensagem.textBody).toContain("Número: 123");
    expect(renderizado.mensagem.textBody).toContain("Cidade / UF: Salvador / BA");
    expect(renderizado.mensagem.textBody).toContain("CEP: 00000-000");
    expect(renderizado.mensagem.textBody).toContain("Telefone Principal: (00) 00000-0000");
  });

  it("FINAL_GOLDEN_WHATSAPP_NOT_INFERRED: WhatsApp NUNCA copia o telefone", () => {
    if (!renderizado.ok) return expect.unreachable();
    expect(renderizado.mensagem.textBody).toContain(
      "WhatsApp Atualizado: informar/confirmar na resposta",
    );
    expect(renderizado.mensagem.textBody).not.toContain("WhatsApp Atualizado: (00)");
  });

  it("FINAL_GOLDEN_CPF_ABSENT: nenhum CPF/identidade sensível no corpo", () => {
    if (!renderizado.ok) return expect.unreachable();
    expect(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(renderizado.mensagem.textBody)).toBe(false);
    expect(renderizado.mensagem.textBody).not.toContain("CPF");
  });

  it("ausente ⇒ Não informado (campos vazios permanecem estruturais)", () => {
    const parcial = renderizarTemplatePersistido({
      persistedTemplateVersion: TEMPLATE_V2_VERSION,
      professionalName: "Profissional Teste",
      correlationCode: "PF26TEST00000000000000000000000000",
      exibicao: { bairro: "  " },
      remetente: { name: "CRT-BA", address: "carteiras@crtba.org.br" },
      campaignId: "00000000-0000-4000-8000-00000000000a",
      itemId: "00000000-0000-4000-8000-00000000000b",
      professionalId: "00000000-0000-4000-8000-0000000000c1",
      recipient: "profissional.teste@exemplo.test",
    });
    expect(parcial.ok).toBe(true);
    if (!parcial.ok) return;
    expect(parcial.mensagem.textBody).toContain("Logradouro / Endereço: Não informado");
    expect(parcial.mensagem.textBody).toContain("Bairro: Não informado");
  });

  it("metadados v2: dataMode PREFILLED_CONFIRMATION (FINAL_GOLDEN_DATA_MODE)", () => {
    const meta = metadadosTemplate(TEMPLATE_V2_VERSION);
    expect(meta.ok).toBe(true);
    expect(meta.dataMode).toBe("PREFILLED_CONFIRMATION");
  });
});

describe("GF2_FINAL — contentHash (status-independente, sensível a conteúdo)", () => {
  it("CONTENT_HASH_STATUS_INDEPENDENT: hash não depende de status/ordem", () => {
    const a = templateContentHash({
      templateId: "PF_EXPEDICAO_CARTEIRA",
      templateVersion: "x",
      scope: "PF_CAMPAIGN",
      dataMode: "PREFILLED_CONFIRMATION",
      subject: "S",
      textDefinition: "T",
      htmlDefinition: "H",
    });
    const b = templateContentHash({
      htmlDefinition: "H",
      textDefinition: "T",
      subject: "S",
      dataMode: "PREFILLED_CONFIRMATION",
      scope: "PF_CAMPAIGN",
      templateVersion: "x",
      templateId: "PF_EXPEDICAO_CARTEIRA",
    });
    expect(a).toBe(b);
  });

  it("CONTENT_HASH_CHANGES_WITH_CONTENT: conteúdo/dataMode diferentes ⇒ hash diferente", () => {
    const base = {
      templateId: "PF_EXPEDICAO_CARTEIRA",
      templateVersion: "x",
      scope: "PF_CAMPAIGN",
      dataMode: "PREFILLED_CONFIRMATION",
      subject: "S",
      textDefinition: "T",
      htmlDefinition: "H",
    };
    expect(templateContentHash(base)).not.toBe(
      templateContentHash({ ...base, textDefinition: "T2" }),
    );
    expect(templateContentHash(base)).not.toBe(templateContentHash({ ...base, dataMode: "RESPONSE_FORM" }));
  });

  it("CONTENT_HASH_USES_FUNCTION_SOURCE / SYNTHETIC_RENDER: hash canônico não avalia funções", () => {
    const fonte = readFileSync(
      new URL("../../../packages/mail/src/templates/pf-campaign-template-registry.ts", import.meta.url),
      "utf-8",
    );
    const inicioHash = fonte.indexOf("function templateContentHash");
    const fimHash = fonte.indexOf("// Definições estáticas", inicioHash);
    const secaoHash = fonte.slice(inicioHash, fimHash);
    expect(secaoHash).not.toContain("toString(");
    expect(secaoHash).not.toContain("renderizar");
    expect(secaoHash).not.toContain("new Date");
    expect(secaoHash).not.toContain("Math.random");
  });
});
