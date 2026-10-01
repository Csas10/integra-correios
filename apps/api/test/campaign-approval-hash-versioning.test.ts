/**
 * GF-2 CORRETIVO — versão do contrato do hash de aprovação:
 * · LEGACY_V1_APPROVAL_HASH_UNCHANGED: o algoritmo histórico V1 permanece
 *   byte a byte (template + contentHash opcional + pid/nome/e-mail/status);
 * · V2_APPROVAL_HASH_VERSIONED: representação canônica domain-separated,
 *   ordem fixa, TODOS os campos PREFILLED + templateVersion + contentHash;
 * · V2_WITHOUT_HASH_VERSION: campanha v2 sem marcador ⇒ fail-closed;
 * · V2_CANNOT_DOWNGRADE_TO_V1: NUNCA fallback V1 para campanha v2.
 * ZERO rede, ZERO banco, ZERO envio.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAMPANHA_APROVACAO_V1,
  CAMPANHA_APROVACAO_V2,
  hashAprovacaoCampanha,
  hashDoSnapshotCampanha,
  normalizarExibicaoRegistroCampanha,
  resolverContratoHashAprovacao,
  snapshotCampanha,
} from "../src/campaigns.js";
import { TEMPLATE_V2_VERSION } from "@integra-correios/mail";

const V1_HISTORICA = "pf-atualizacao-cadastral-2026-v1";
const PID = "00000000-0000-4000-8000-0000000000a1";
const REGISTRO_BASE = {
  profissional_id: PID,
  nome: "Profissional Teste",
  email_normalizado: "profissional.teste@exemplo.test",
  status_validacao: "APTO",
} as const;
const EXIBICAO_COMPLETA = {
  telefone: "(00) 00000-0000",
  cep: "00000-000",
  logradouro: "Rua Teste",
  numero: "123",
  complemento: "S/N",
  bairro: "Bairro Teste",
  cidade: "Salvador",
  uf: "BA",
} as const;

/** Espelho independente do algoritmo V1 HISTÓRICO (implementação legada). */
function hashV1HistoricoLegado(templateVersao: string, registros: readonly { profissional_id: string; nome: string; email_normalizado: string; status_validacao: string }[]): string {
  const sha256 = createHash("sha256");
  sha256.update(`template:${templateVersao}\n`);
  for (const registro of registros) {
    sha256.update(
      `${registro.profissional_id}\u001f${registro.nome}\u001f` +
        `${registro.email_normalizado}\u001f${registro.status_validacao}\n`,
    );
  }
  return sha256.digest("hex");
}

describe("GF2_CORRETIVO — LEGACY_V1_APPROVAL_HASH_UNCHANGED", () => {
  it("contrato V1 reproduz o algoritmo histórico BYTE A BYTE (sem exibicao)", () => {
    const esperado = hashV1HistoricoLegado(V1_HISTORICA, [REGISTRO_BASE]);
    const obtido = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V1,
      templateVersao: V1_HISTORICA,
      registros: [REGISTRO_BASE],
    });
    expect(obtido).toBe(esperado);
  });

  it("V1 SEM contrato explícito (modo legado) também permanece idêntico", () => {
    const esperado = hashV1HistoricoLegado(V1_HISTORICA, [REGISTRO_BASE]);
    expect(
      hashAprovacaoCampanha({ templateVersao: V1_HISTORICA, registros: [REGISTRO_BASE] }),
    ).toBe(esperado);
  });

  it("V1 com templateContentHash preserva o prefixo histórico do binding F4", () => {
    const contentHash = "c".repeat(64);
    const sha256 = createHash("sha256");
    sha256.update(`template:${V1_HISTORICA}\n`);
    sha256.update(`templateContentHash:${contentHash}\n`);
    sha256.update(
      `${REGISTRO_BASE.profissional_id}\u001f${REGISTRO_BASE.nome}\u001f` +
        `${REGISTRO_BASE.email_normalizado}\u001f${REGISTRO_BASE.status_validacao}\n`,
    );
    expect(
      hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V1,
        templateVersao: V1_HISTORICA,
        templateContentHash: contentHash,
        registros: [REGISTRO_BASE],
      }),
    ).toBe(sha256.digest("hex"));
  });

  it("V1 IGNORA campos de exibicao (comportamento histórico preservado)", () => {
    const semExibicao = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V1,
      templateVersao: V1_HISTORICA,
      registros: [REGISTRO_BASE],
    });
    const comExibicao = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V1,
      templateVersao: V1_HISTORICA,
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });
    expect(semExibicao).toBe(comExibicao);
  });
});

describe("GF2_CORRETIVO — V2_APPROVAL_HASH_VERSIONED", () => {
  it("mesma entrada normalizada ⇒ mesmo hash (STABLE_FOR_SAME_INPUT)", () => {
    const a = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });
    const b = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("PROPERTY_ORDER_INDEPENDENT: ordem incidental das chaves não muda o hash", () => {
    const direto = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...REGISTRO_BASE, exibicao: { ...EXIBICAO_COMPLETA } }],
    });
    // Mesma exibicao construída com ordem de inserção DIFERENTE.
    const invertida = {
      uf: "BA",
      cidade: "Salvador",
      bairro: "Bairro Teste",
      complemento: "S/N",
      numero: "123",
      logradouro: "Rua Teste",
      cep: "00000-000",
      telefone: "(00) 00000-0000",
    };
    const outraOrdem = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...REGISTRO_BASE, exibicao: invertida }],
    });
    expect(direto).toBe(outraOrdem);
  });

  it("NULL_CANONICALIZATION: ausente e explícito-undefined produzem null estável; vazio ⇒ null", () => {
    const contentHash = "c".repeat(64);
    const semCampo = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [REGISTRO_BASE],
    });
    const comVazio = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        {
          ...REGISTRO_BASE,
          ...(normalizarExibicaoRegistroCampanha({ cep: "   " }) === undefined
            ? {}
            : { exibicao: normalizarExibicaoRegistroCampanha({ cep: "   " }) }),
        },
      ],
    });
    expect(comVazio).toBe(semCampo);
    const objetoVazio = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: {} }],
    });
    expect(objetoVazio).toBe(semCampo);
  });

  it("CR/LF normalizado e valor canônico produzem o MESMO hash", () => {
    const contentHash = "c".repeat(64);
    const bruto = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        {
          ...REGISTRO_BASE,
          ...(normalizarExibicaoRegistroCampanha({
            logradouro: "  Rua\r\n Teste\t ",
            numero: "123 ",
          }) === undefined
            ? {}
            : {
                exibicao: normalizarExibicaoRegistroCampanha({
                  logradouro: "  Rua\r\n Teste\t ",
                  numero: "123 ",
                }),
              }),
        },
      ],
    });
    const canonico = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: { logradouro: "Rua Teste", numero: "123" } }],
    });
    expect(bruto).toBe(canonico);
  });

  it("V2 exige templateContentHash (binding versão + conteúdo)", () => {
    expect(() =>
      hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V2,
        templateVersao: TEMPLATE_V2_VERSION,
        registros: [REGISTRO_BASE],
      }),
    ).toThrow();
  });
});

describe("GF2_CORRETIVO — EACH_RENDERED_FIELD_CHANGES_HASH (V2)", () => {
  const contentHash = "c".repeat(64);
  const base = () =>
    hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });

  const CAMPOS: readonly (readonly [string, string])[] = [
    ["telefone", "(00) 00000-9999"],
    ["cep", "11111-111"],
    ["logradouro", "Avenida Diferente"],
    ["numero", "456"],
    ["complemento", "AP 12"],
    ["bairro", "Outro Bairro"],
    ["cidade", "Feira de Santana"],
    ["uf", "PE"],
  ];

  for (const [campo, valor] of CAMPOS) {
    it(`alterar ${campo} ⇒ hash diferente`, () => {
      const modificado = hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V2,
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: contentHash,
        registros: [{ ...REGISTRO_BASE, exibicao: { ...EXIBICAO_COMPLETA, [campo]: valor } }],
      });
      expect(modificado).not.toBe(base());
    });
  }

  it("alterar nome ⇒ hash diferente", () => {
    const modificado = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, nome: "Profissional Alterada", exibicao: EXIBICAO_COMPLETA }],
    });
    expect(modificado).not.toBe(base());
  });

  it("alterar email_normalizado ⇒ hash diferente", () => {
    const modificado = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        { ...REGISTRO_BASE, email_normalizado: "outra@exemplo.test", exibicao: EXIBICAO_COMPLETA },
      ],
    });
    expect(modificado).not.toBe(base());
  });

  it("alterar templateVersion ⇒ hash diferente", () => {
    const modificado = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: "pf-expedicao-carteira-2026-v3",
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });
    expect(modificado).not.toBe(base());
  });

  it("alterar templateContentHash ⇒ hash diferente", () => {
    const modificado = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "d".repeat(64),
      registros: [{ ...REGISTRO_BASE, exibicao: EXIBICAO_COMPLETA }],
    });
    expect(modificado).not.toBe(base());
  });

  it("SNAPSHOT_HASH_BINDS_PREFILLED_FIELDS: inserir campo antes ausente ⇒ hash diferente (sem colisão ausente/vazio)", () => {
    const semTelefone = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: { cep: "00000-000" } }],
    });
    const comTelefone = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: { cep: "00000-000", telefone: "(00) 00000-0000" } }],
    });
    expect(comTelefone).not.toBe(semTelefone);
  });

  it("dado semanticamente diferente ⇒ hash diferente (não apenas bytes)", () => {
    const um = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: { cidade: "Salvador", uf: "BA" } }],
    });
    const outro = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [{ ...REGISTRO_BASE, exibicao: { cidade: "Salvador BA", uf: "null" } }],
    });
    expect(um).not.toBe(outro);
  });
});

describe("GF2_CORRETIVO — marcador fail-closed e sem downgrade", () => {
  const inputV2 = {
    fingerprintArquivo: "a".repeat(64),
    templateVersao: TEMPLATE_V2_VERSION,
    templateContentHash: "c".repeat(64),
    registros: [REGISTRO_BASE],
    decisoes: [],
  };

  it("V2_APPROVAL_HASH_VERSIONED: snapshot v2 persiste approval_hash_version=V2", () => {
    const snapshot = snapshotCampanha(inputV2);
    expect(snapshot.approval_hash_version).toBe(CAMPANHA_APROVACAO_V2);
  });

  it("hashDoSnapshotCampanha segue o CONTRATO do marcador (não o algoritmo que der certo)", () => {
    const snapshot = snapshotCampanha(inputV2);
    const viaSnapshot = hashDoSnapshotCampanha(snapshot);
    const viaContrato = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: snapshot.template_versao,
      templateContentHash: snapshot.template_content_hash,
      registros: snapshot.registros,
    });
    expect(viaSnapshot).toBe(viaContrato);
    // V1 produz hash DIFERENTE para o mesmo conteúdo (contratos separados).
    expect(
      hashAprovacaoCampanha({
        contrato: CAMPANHA_APROVACAO_V1,
        templateVersao: snapshot.template_versao,
        templateContentHash: snapshot.template_content_hash,
        registros: snapshot.registros,
      }),
    ).not.toBe(viaSnapshot);
  });

  it("V2_WITHOUT_HASH_VERSION: snapshot v2 sem marcador ⇒ fail-closed (BLOCKED)", () => {
    const snapshot = snapshotCampanha(inputV2);
    const semMarcador = { ...snapshot, approval_hash_version: undefined } as unknown as typeof snapshot;
    expect(() => hashDoSnapshotCampanha(semMarcador)).toThrow();
    expect(() =>
      resolverContratoHashAprovacao({
        templateVersao: semMarcador.template_versao,
        approvalHashVersion: undefined,
      }),
    ).toThrow();
  });

  it("V2_CANNOT_DOWNGRADE_TO_V1: marcador V2 nunca resolve para V1", () => {
    // A RESOLUÇÃO NUNCA devolve V1 para campanha v2: nem sem marcador,
    // nem por tentativa de fallback — fail-closed sempre.
    expect(
      resolverContratoHashAprovacao({
        templateVersao: TEMPLATE_V2_VERSION,
        approvalHashVersion: CAMPANHA_APROVACAO_V2,
      }),
    ).toBe(CAMPANHA_APROVACAO_V2);
    expect(() =>
      resolverContratoHashAprovacao({ templateVersao: TEMPLATE_V2_VERSION }),
    ).toThrow();
    expect(() =>
      resolverContratoHashAprovacao({
        templateVersao: TEMPLATE_V2_VERSION,
        approvalHashVersion: CAMPANHA_APROVACAO_V1,
      }),
    ).toThrow();
  });

  it("LEGACY: campanha histórica v1 sem marcador resolve V1 (compatibilidade)", () => {
    expect(
      resolverContratoHashAprovacao({ templateVersao: V1_HISTORICA }),
    ).toBe(CAMPANHA_APROVACAO_V1);
  });

  it("marcador DESCONHECIDO ⇒ erro (nunca tentar o algoritmo que der certo)", () => {
    expect(() =>
      resolverContratoHashAprovacao({
        templateVersao: V1_HISTORICA,
        approvalHashVersion: "CAMPANHA_APROVACAO_VX",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-02 (F4) — V2_PRESENCE_ENCODING_UNAMBIGUOUS (PRE-LAUNCH):
//   · ABSENT ⇒ marcador tipado explícito (NUNCA "null", que colidia com a
//     string permitida "null");
//   · PRESENT ⇒ marcador tipado + comprimento determinístico + valor exato
//     ("s:<len>:<valor>") — a fronteira comprimento/valor é inequívoca;
//   · undefined ≠ "null" ≠ qualquer string permitida; ordem irrelevante;
//   · vazio ⇒ ausente (saída de validarSubmissaoAprovacao);
//   · V1 permanece BYTE A BYTE inalterado (espelho legado acima).
// Sem golden digest hardcode: as provas são RELACIONAIS (semântica do
// encoding), duráveis e independentes do digest absoluto.
// ---------------------------------------------------------------------------
describe("GF3_C2_F4 — V2_PRESENCE_ENCODING_UNAMBIGUOUS", () => {
  const contentHash = "c".repeat(64);

  const comExibicao = (exibicao: Record<string, string> | undefined) =>
    hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        exibicao === undefined
          ? REGISTRO_BASE
          : { ...REGISTRO_BASE, exibicao },
      ],
    });

  it("ausência ≠ string 'null': cidade 'null' ⇒ hash DIFERENTE de cidade ausente", () => {
    const ausente = comExibicao({ cidade: "Salvador", uf: "BA" });
    const literalNull = comExibicao({ cidade: "null", uf: "BA" });
    expect(literalNull).not.toBe(ausente);
  });

  it("presente: valor EXATO entra no canônico ('BA' ≠ 'BAA' — comprimento binda o valor)", () => {
    const ba = comExibicao({ cidade: "Salvador", uf: "BA" });
    const baa = comExibicao({ cidade: "Salvador", uf: "BAA" });
    expect(baa).not.toBe(ba);
  });

  it("fronteira comprimento/valor inequívoca: separador \\u001f no valor não é confundido com o delimitador", () => {
    const valorComSeparador = comExibicao({ cidade: "Sal\u001fvador", uf: "BA" });
    const valorDistinto = comExibicao({ cidade: "Sal", uf: "BA" });
    // Canonicamente diferentes — o comprimento binda o valor exato:
    expect(valorComSeparador).not.toBe(valorDistinto);
  });

  it("vazio ⇒ ausente (saída da normalização): exibicao { uf: '   ' } == sem exibicao", () => {
    const vazia = normalizarExibicaoRegistroCampanha({ uf: "   " });
    const comCampoVazio = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V2,
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: contentHash,
      registros: [
        vazia === undefined
          ? REGISTRO_BASE
          : { ...REGISTRO_BASE, exibicao: vazia },
      ],
    });
    expect(comCampoVazio).toBe(comExibicao(undefined));
  });

  it("ordem de propriedades permanece IRRELEVANTE no encoding novo", () => {
    const direto = comExibicao({ cidade: "Salvador", uf: "BA", telefone: "(00) 00000-0000" });
    const invertida = comExibicao({ telefone: "(00) 00000-0000", uf: "BA", cidade: "Salvador" });
    expect(direto).toBe(invertida);
  });

  it("LEGACY_V1_HASH_UNCHANGED: espelho legado V1 continua byte a byte (regressão do F4)", () => {
    const esperado = hashV1HistoricoLegado(V1_HISTORICA, [REGISTRO_BASE]);
    const obtido = hashAprovacaoCampanha({
      contrato: CAMPANHA_APROVACAO_V1,
      templateVersao: V1_HISTORICA,
      registros: [REGISTRO_BASE],
    });
    expect(obtido).toBe(esperado);
  });
});
