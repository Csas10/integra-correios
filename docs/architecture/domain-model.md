# Modelo de domínio

## Origem e identidade

Existe um único motor com duas origens:

```text
PF | PJ
```

A identidade operacional é composta por origem e código:

```text
PF|CODIGO
PJ|CODIGO
```

O documento não é chave global de ingestão. Duplicidades precisam ser recebidas,
identificadas e auditadas como inconsistências, sem desaparecer por restrição de
unicidade prematura.

## Lotes

```text
PF-LOTE001
PJ-LOTE001
```

Um lote contém somente itens de sua própria origem e não pode repetir a mesma
identidade. PF e PJ compartilham regras técnicas, mas nunca o mesmo identificador
de lote, trilha de auditoria ou resultado de reconciliação.

## Confirmação PF

PF possui um gate anterior à pré-postagem:

```text
RECEBIDO
  -> APTO_CONTATO
  -> EMAIL_ENVIADO
  -> AGUARDANDO_CONFIRMACAO
  -> CONFIRMADO_SEM_ALTERACAO | CONFIRMADO_COM_ALTERACAO
  -> EM_VALIDACAO
  -> APTO_PREPOSTAGEM
```

PJ pode avançar de `RECEBIDO` para `EM_VALIDACAO`, pois a planilha empresarial
já foi formatada, testada e validada. A origem continua explícita em todos os
passos.

## Estados posteriores

```text
APTO_PREPOSTAGEM -> EM_LOTE -> ENVIADO -> CONFIRMADO
                                      -> REJEITADO -> RETESTE
```

Transições não previstas são bloqueadas por `TransicaoInvalidaError`.
