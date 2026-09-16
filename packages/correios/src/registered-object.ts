import type { ObjetoRegistradoPpn, PessoaPpn } from "./dto.js";
import { PERFIL_OURO_PPN } from "./profile.js";

export interface DadosObjetoRegistrado {
  readonly sequencial: string;
  readonly remetente: PessoaPpn;
  readonly destinatario: PessoaPpn;
}

export function montarObjetoPerfilOuro(dados: DadosObjetoRegistrado): ObjetoRegistradoPpn {
  return {
    sequencial: dados.sequencial,
    remetente: dados.remetente,
    destinatario: dados.destinatario,
    codigoServico: PERFIL_OURO_PPN.codigoServico,
    logisticaReversa: "N",
    pesoInformado: PERFIL_OURO_PPN.pesoInformado,
    codigoFormatoObjetoInformado: PERFIL_OURO_PPN.codigoFormatoObjetoInformado,
    cienteObjetoNaoProibido: PERFIL_OURO_PPN.cienteObjetoNaoProibido,
    listaServicoAdicional: PERFIL_OURO_PPN.listaServicoAdicional,
    itensDeclaracaoConteudo: PERFIL_OURO_PPN.itensDeclaracaoConteudo,
  };
}
