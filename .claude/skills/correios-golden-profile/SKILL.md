---
name: correios-golden-profile
description: Protect the homologated Correios PPN Golden Profile and its semantic regression invariants.
---

# Correios Golden Profile

## Frozen homologated profile

codigoServico = "03220"
codigoFormatoObjetoInformado = "1"
pesoInformado = 10

AR = "001"
RR = "025"

declaracao:
  conteudo = "DOCUMENTO"
  quantidade = 1
  valor = 20

Do not emit:

- alturaInformada
- larguraInformada
- comprimentoInformado
- diametroInformado

`codigoObjeto` is omitted and assigned by Correios.

## Rule

Do not alter these values because of assumptions, documentation differences or
PPN error TXT fields showing null/empty values.

Change this profile only when new direct PPN homologation evidence explicitly
justifies a change.

## Regression requirement

Legacy and V2 output comparison must require semantic equivalence for:

- service;
- format;
- weight;
- AR;
- RR;
- declaration;
- recipient;
- omission of dimensions.

JSON object property order is irrelevant.