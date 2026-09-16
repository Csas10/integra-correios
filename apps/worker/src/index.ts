import type { ArquivoGerado, PrePostagemGateway } from "@integra-correios/correios";
import { validarItensDoLote, type Lote } from "@integra-correios/domain";

export class ProcessadorDeLotes {
  constructor(private readonly gateway: PrePostagemGateway) {}

  async gerar(lote: Lote): Promise<ArquivoGerado> {
    validarItensDoLote(lote);
    return this.gateway.gerarLote(lote);
  }
}
