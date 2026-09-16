---
name: ppn-orchestration
description: Implement deterministic Correios PPN lot generation, return reconciliation, gates and audit without changing the Golden Profile.
---

# Integra Correios — PPN Orchestration

## Shared engine

PF and PJ use one engine.

Segregate ORIGEM = PF | PJ and preserve stable identities such as PF|<codigo>
and PJ|<codigo>.

## Eligibility

Only APTO_PREPOSTAGEM records may be reserved into a PPN lot.

Reservation is persistent and atomic.

## Lifecycle

IMPORTADO
→ NORMALIZADO
→ VALIDADO_LOCALMENTE
→ ELEGIVEL
→ RESERVADO_LOTE
→ JSON_GERADO
→ ENVIADO_PPN
→ PROCESSADO_PPN
→ PREPOSTAGEM_CONFIRMADA | REJEITADO_CORREIOS
→ CORRECAO
→ RETESTE

## Lots

Persist lot ID, origin, selected count, timestamp, JSON artifact name/hash,
send state, success/rejection counts, reconciliation count, materialization and
final gate.

## Golden Profile

Always combine with correios-golden-profile.

Do not redefine its values here.

## Return parsing

PPN return TXT may contain flattened JSON blocks plus textual errors.

Do not assume one JSON document.

Use balanced extraction and deterministic reconciliation.

## Identity

Never reconcile by row/order.

Prefer stable identity:
CODIGO → CPF/CNPJ → CHAVE → sequential identifier → explicit line fallback only
when designed for that artifact.

## Gates

Do not reuse outgoing JSON as return.

Do not fabricate empty inconsistency files.

Zero inconsistency is an explicit valid closure state.

Do not silently correct rejected CEP/address.

## Artifacts

Operational PPN import artifact is JSON.

XLSX is audit/operator output unless separately homologated.

## Idempotency

Generation, submission recording and return reconciliation must be idempotent.

A replayed return file must not double-apply transitions.

## Tests

Cover PF/PJ same engine, lot conflicts, Golden Profile regression, zero
inconsistency, partial rejection, duplicate return, identity independent of
order and blocked next lot while gate remains open.
