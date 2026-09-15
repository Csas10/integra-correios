import type { Lote, LoteId } from "@integra-correios/domain";

export interface ArquivoGerado {
  readonly nome: string;
  readonly sha256: string;
  readonly quantidade: number;
}

export interface ArquivoEntrada {
  readonly nome: string;
  readonly sha256: string;
  readonly conteudo: Uint8Array;
}

export interface RetornoProcessado {
  readonly confirmados: number;
  readonly rejeitados: number;
  readonly total: number;
}

export interface Reconciliacao {
  readonly loteId: LoteId;
  readonly enviados: number;
  readonly reconciliados: number;
  readonly completa: boolean;
}

export interface PrePostagemGateway {
  gerarLote(lote: Lote): Promise<ArquivoGerado>;
  importarRetorno(arquivo: ArquivoEntrada): Promise<RetornoProcessado>;
  reconciliar(loteId: LoteId): Promise<Reconciliacao>;
}

export class CorreiosPPNGatewayNaoConfigurado implements PrePostagemGateway {
  async gerarLote(_lote: Lote): Promise<ArquivoGerado> {
    throw new Error("Integração de rede com o PPN não configurada nesta fase");
  }

  async importarRetorno(_arquivo: ArquivoEntrada): Promise<RetornoProcessado> {
    throw new Error("Importação de retorno não configurada nesta fase");
  }

  async reconciliar(_loteId: LoteId): Promise<Reconciliacao> {
    throw new Error("Reconciliação persistente não configurada nesta fase");
  }
}
