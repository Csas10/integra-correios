import { describe, expect, it } from "vitest";
import { visaoEtapa8 } from "../src/pages/campaign-step8-presentation.js";

const campanhaSemLote = {
  campanhaId: "d3111f40-6b9b-498d-9a75-4385bea04e52",
  hashAprovacao: "dc3323eb71bb4431" + "0".repeat(48),
  loteId: null,
};
const campanhaComLote = { ...campanhaSemLote, loteId: "lote-1" };

describe("CampaignWorkspace etapa 08 — decisão pura de apresentação", () => {
  it("PÓS-RELOAD (base=null, aprovacao=null): campanha reconstruída libera o CTA de lote e o fallback NÃO substitui a campanha", () => {
    const visao = visaoEtapa8({
      basePresente: false,
      aprovacaoPresente: false,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: true,
      campanha: campanhaSemLote,
    });
    expect(visao.mostrarPainelCampanhaReconstruida).toBe(true);
    expect(visao.mostrarCtaCriarLote).toBe(true);
    expect(visao.mostrarFallbackImportacao).toBe(false);
    expect(visao.mostrarFluxoAprovacao).toBe(false);
    expect(visao.mostrarCtaPersistencia).toBe(false);
    expect(visao.mostrarAcompanharCampanha).toBe(true);
    expect(visao.payloadCriarLote).toEqual({
      campanhaId: campanhaSemLote.campanhaId,
      conteudoHash: campanhaSemLote.hashAprovacao,
    });
  });

  it("APROVAÇÃO DA SESSÃO (aprovacao + canPersistImport=true): CTA de persistência disponível", () => {
    const visao = visaoEtapa8({
      basePresente: true,
      aprovacaoPresente: true,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: true,
      campanha: null,
    });
    expect(visao.mostrarFluxoAprovacao).toBe(true);
    expect(visao.mostrarCtaPersistencia).toBe(true);
    expect(visao.mostrarPainelCampanhaReconstruida).toBe(false);
    expect(visao.mostrarCtaCriarLote).toBe(false);
    expect(visao.payloadCriarLote).toBeNull();
  });

  it("campanha ausente: nenhum CTA de lote e fallback de importação ativo", () => {
    const visao = visaoEtapa8({
      basePresente: false,
      aprovacaoPresente: false,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: true,
      campanha: null,
    });
    expect(visao.mostrarCtaCriarLote).toBe(false);
    expect(visao.mostrarPainelCampanhaReconstruida).toBe(false);
    expect(visao.mostrarFallbackImportacao).toBe(true);
  });

  it("canCreateBatch=false: CTA de lote indisponível mesmo com campanha presente", () => {
    const visao = visaoEtapa8({
      basePresente: false,
      aprovacaoPresente: false,
      canPersistImport: true,
      canCreateBatch: false,
      acaoExecutarLote: true,
      campanha: campanhaSemLote,
    });
    expect(visao.mostrarCtaCriarLote).toBe(false);
    expect(visao.mostrarPainelCampanhaReconstruida).toBe(true);
    expect(visao.mostrarAcompanharCampanha).toBe(true);
  });

  it("EXECUTAR_LOTE ausente: CTA de lote indisponível", () => {
    const visao = visaoEtapa8({
      basePresente: false,
      aprovacaoPresente: false,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: false,
      campanha: campanhaSemLote,
    });
    expect(visao.mostrarCtaCriarLote).toBe(false);
  });

  it("campanha.loteId presente: NENHUMA segunda ação ativa de criação; estado do lote é exibido", () => {
    const visao = visaoEtapa8({
      basePresente: false,
      aprovacaoPresente: false,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: true,
      campanha: campanhaComLote,
    });
    expect(visao.mostrarCtaCriarLote).toBe(false);
    expect(visao.mostrarLoteExistente).toBe(true);
    expect(visao.mostrarAcompanharCampanha).toBe(true);
    expect(visao.payloadCriarLote).toEqual({
      campanhaId: campanhaComLote.campanhaId,
      conteudoHash: campanhaComLote.hashAprovacao,
    });
  });

  it("payload do lote usa EXCLUSIVAMENTE a campanha persistida (nunca a aprovação transitória)", () => {
    const visao = visaoEtapa8({
      basePresente: true,
      aprovacaoPresente: true,
      canPersistImport: true,
      canCreateBatch: true,
      acaoExecutarLote: true,
      campanha: campanhaSemLote,
    });
    expect(visao.payloadCriarLote).toEqual({
      campanhaId: "d3111f40-6b9b-498d-9a75-4385bea04e52",
      conteudoHash: campanhaSemLote.hashAprovacao,
    });
  });
});
