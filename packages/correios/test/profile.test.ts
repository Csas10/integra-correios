import { describe, expect, it } from "vitest";
import {
  CorreiosPPNGatewayNaoConfigurado,
  montarObjetoPerfilOuro,
  PERFIL_OURO_PPN,
  type PessoaPpn,
} from "../src/index.js";

const pessoaEstrutural = (): PessoaPpn => ({
  nome: "NAO_PERSISTIDO",
  cpfCnpj: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1].join(""),
  endereco: {
    cep: [1, 2, 3, 4, 5, 6, 7, 8].join(""),
    logradouro: "NAO_PERSISTIDO",
    numero: "0",
    bairro: "NAO_PERSISTIDO",
    cidade: "NAO_PERSISTIDO",
    uf: "BA",
  },
});

describe("Perfil Ouro PPN", () => {
  it("congela códigos como strings e valores JSON nos tipos corretos", () => {
    expect(PERFIL_OURO_PPN.codigoServico).toBe("03220");
    expect(PERFIL_OURO_PPN.codigoFormatoObjetoInformado).toBe("1");
    expect(PERFIL_OURO_PPN.pesoInformado).toBe("10");
    expect(PERFIL_OURO_PPN.listaServicoAdicional.map((item) => item.codigoServicoAdicional)).toEqual([
      "001",
      "025",
    ]);
    expect(PERFIL_OURO_PPN.cienteObjetoNaoProibido).toBe(1);
    expect(PERFIL_OURO_PPN.itensDeclaracaoConteudo[0]).toEqual({
      conteudo: "DOCUMENTO",
      quantidade: 1,
      valor: 20,
    });
  });

  it("omite dimensões no formato envelope", () => {
    const objeto = montarObjetoPerfilOuro({
      sequencial: "1",
      remetente: pessoaEstrutural(),
      destinatario: pessoaEstrutural(),
    });
    expect(objeto).not.toHaveProperty("alturaInformada");
    expect(objeto).not.toHaveProperty("larguraInformada");
    expect(objeto).not.toHaveProperty("comprimentoInformado");
    expect(objeto).not.toHaveProperty("diametroInformado");
    expect(typeof objeto.itensDeclaracaoConteudo[0]?.quantidade).toBe("number");
    expect(typeof objeto.itensDeclaracaoConteudo[0]?.valor).toBe("number");
  });
});

describe("gateway", () => {
  it("impede chamada real ao PPN enquanto a integração não estiver configurada", async () => {
    const gateway = new CorreiosPPNGatewayNaoConfigurado();
    await expect(gateway.reconciliar("PJ-LOTE001")).rejects.toThrow("não configurada");
  });
});
