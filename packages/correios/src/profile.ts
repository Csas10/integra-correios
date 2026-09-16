export const PERFIL_OURO_PPN = Object.freeze({
  codigoServico: "03220" as const,
  codigoFormatoObjetoInformado: "1" as const,
  pesoInformado: "10" as const,
  listaServicoAdicional: Object.freeze([
    Object.freeze({ codigoServicoAdicional: "001" as const }),
    Object.freeze({ codigoServicoAdicional: "025" as const }),
  ]),
  cienteObjetoNaoProibido: 1 as const,
  itensDeclaracaoConteudo: Object.freeze([
    Object.freeze({ conteudo: "DOCUMENTO" as const, quantidade: 1 as const, valor: 20 }),
  ]),
});

export type PerfilOuroPpn = typeof PERFIL_OURO_PPN;
