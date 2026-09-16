export interface EnderecoPpn {
  readonly cep: string;
  readonly logradouro: string;
  readonly numero: string;
  readonly complemento?: string;
  readonly bairro: string;
  readonly cidade: string;
  readonly uf: string;
}

export interface PessoaPpn {
  readonly nome: string;
  readonly cpfCnpj: string;
  readonly dddTelefone?: string;
  readonly telefone?: string;
  readonly dddCelular?: string;
  readonly celular?: string;
  readonly email?: string;
  readonly endereco: EnderecoPpn;
}

export interface ServicoAdicionalPpn {
  readonly codigoServicoAdicional: string;
}

export interface ItemDeclaracaoConteudoPpn {
  readonly conteudo: string;
  readonly quantidade: number;
  readonly valor: number;
}

export interface ObjetoRegistradoPpn {
  readonly sequencial: string;
  readonly remetente: PessoaPpn;
  readonly destinatario: PessoaPpn;
  readonly codigoServico: string;
  readonly logisticaReversa: "N";
  readonly pesoInformado: string;
  readonly codigoFormatoObjetoInformado: "1";
  readonly cienteObjetoNaoProibido: 1;
  readonly listaServicoAdicional: readonly ServicoAdicionalPpn[];
  readonly itensDeclaracaoConteudo: readonly ItemDeclaracaoConteudoPpn[];
}
