# Perfil Ouro PPN

Contrato congelado a partir da homologação PJ:

| Campo | Valor e tipo |
|---|---|
| `codigoServico` | `"03220"` (String) |
| `codigoFormatoObjetoInformado` | `"1"` (String, envelope) |
| `pesoInformado` | `"10"` (String) |
| AR | `"001"` (String) |
| RR | `"025"` (String) |
| `cienteObjetoNaoProibido` | `1` (Integer) |
| Conteúdo | `"DOCUMENTO"` |
| Quantidade | `1` (Integer) |
| Valor | `20` (Number) |
| Logística reversa | `"N"` |

Envelope não informa altura, largura, comprimento ou diâmetro. Remetente e
destinatário são objetos aninhados, cada qual com endereço aninhado. Códigos não
podem ser convertidos para número.

O pacote `@integra-correios/correios` implementa somente transformação pura e o
contrato do gateway. A classe padrão falha de forma fechada: não existe chamada
de rede nesta etapa.
