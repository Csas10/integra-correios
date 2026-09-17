---
name: pf-workflow
description: Preserve the professional PF confirmation lifecycle, audit invariants and APTO_PREPOSTAGEM gate in Integra Correios.
---

# Integra Correios — PF Workflow

## Canonical lifecycle

CARTEIRA_IDENTIFICADA
→ APTO_CONTATO
→ EMAIL_PENDENTE
→ EMAIL_ENVIADO
→ AGUARDANDO_CONFIRMACAO
→ CONFIRMADO_SEM_ALTERACAO | CONFIRMADO_COM_ALTERACAO
→ EM_VALIDACAO
→ APTO_PREPOSTAGEM

Alternative/error states may include PENDENCIA_CADASTRAL and communication
failure states.

## Core invariant

No PF record may enter a PPN lot unless it is APTO_PREPOSTAGEM.

Importing, mapping, sending an email or receiving a reply does not by itself
make the record APTO_PREPOSTAGEM.

## Source versus confirmed data

Never silently overwrite imported/source data.

Maintain at least:
- original/source snapshot;
- proposed/confirmed snapshot;
- confirmation_id;
- source of change;
- confirmed_at;
- actor/channel responsible for the change.

## Confirmation

Use a secure random token tied server-side to the professional.

The URL contains only a high-entropy token, never CPF/CNPJ.

Consumption must validate hash and expiry, atomically consume PENDING state,
reject replay, create audit events and preserve the original snapshot.

## Communication

Store professional_id, channel, template_version, destination reference,
sent_at, provider_message_id, provider_thread_id when available, delivery status
and confirmation_id.

Provider delivery is not cadastral confirmation.

## Email

Do not include CPF in the email body.

Prefer secure actions:
- CONFIRMAR DADOS
- ATUALIZAR DADOS

Manual email reply may remain fallback but must be reconciled by an operator.

## APTO_PREPOSTAGEM gate

Requires valid identity, valid address/CEP, completed confirmation, no blocking
identifier warning, no unresolved cadastral pending issue and an audit event.

## Tests

Cover valid/update confirmation, expiry, replay, concurrency, invalid address,
pending cadastral state, audit sequence and no premature APTO_PREPOSTAGEM.
