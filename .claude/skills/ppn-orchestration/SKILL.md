---
name: ppn-orchestration
description: Implement deterministic Correios PPN lot generation, return reconciliation, gates and audit without changing the Golden Profile.
---

# Integra Correios — PPN Orchestration

## Shared engine

PF and PJ use one engine.

Segregate ORIGEM = PF | PJ and preserve stable identities such as PF|<codigo>
and PJ|<codigo>.

## Authoritative domain contract

The executable TypeScript domain contract is authoritative.
A skill must never introduce new persisted domain states without
an explicit domain change, ADR, migrations and human approval.

The canonical operational lifecycle is defined in
`packages/domain/src/status.ts` (`STATUS_OPERACIONAIS` +
`transicoesPermitidas`). Do not invent statuses here.

The PostgreSQL `CHECK` is currently broader than `STATUS_OPERACIONAIS`.
That broader persistence constraint must not be interpreted as authorization
for PPN orchestration to emit additional `profissional.status` values.

## Eligibility

Only APTO_PREPOSTAGEM records may be reserved into a PPN lot.

Reservation is persistent and atomic.

## Lifecycle (canonical professional.status)

Happy path:

APTO_PREPOSTAGEM
→ EM_LOTE
→ ENVIADO
→ CONFIRMADO

On rejection:

ENVIADO
→ REJEITADO
→ RETESTE
→ EM_VALIDACAO
→ APTO_PREPOSTAGEM

## PPN concepts that are NOT professional.status values

The following concepts belong to artifacts, events and reconciliation —
never to `profissional.status`. The TypeScript domain contract restricts PPN
orchestration to the values in `STATUS_OPERACIONAIS`; the current PostgreSQL
`CHECK` remains broader, as documented under **Known divergence** below, and
must not be interpreted as authorization to emit additional values:

- Lot-level milestones: the lot being generated, sent, processed and
  acknowledged is a **milestone of the lot**, tracked on the lot and its
  audit events.
- JSON generation, submission and processing results are **artifact
  state and audit events**, not professional states.
- Rejection reasons (including CEP/address rejections) are
  **reconciliation results** recorded per item; the professional status
  that results from them is REJEITADO, following the canonical
  transitions above.
- Corrections and retests are **audit events plus canonical status
  transitions** (REJEITADO → RETESTE → EM_VALIDACAO).

These concepts must be described as audit events, lot milestones,
artifact state or reconciliation results — and must never be persisted
as `profissional.status`.

### Known divergence (do not widen)

The `CHECK` constraint on `profissional.status` in
`database/migrations/0001_operational_persistence.sql` currently accepts
additional values that are NOT in `STATUS_OPERACIONAIS`:
`CARTEIRA_IDENTIFICADA`, `PENDENCIA_TRIAGEM`, `EMAIL_PENDENTE`,
`PENDENCIA_CADASTRAL`, `INCLUIDO_EM_LOTE` and `POSTADO`.

These additional values are present in the migration but are not valid
transitions in `packages/domain/src/status.ts` and must not be produced by PPN
orchestration code. In particular, `INCLUIDO_EM_LOTE` and `POSTADO` are
lot/artifact milestones and remain forbidden as `profissional.status`.

Aligning the TypeScript contract and the migration requires an explicit
domain change: ADR, new migration and human approval (see rule above).
Do not emit, map to, or normalize onto these values from this skill.

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
