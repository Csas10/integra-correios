---
name: operational-persistence
description: Implement PostgreSQL transactional persistence, audit, idempotency and outbox patterns for Integra Correios.
---

# Integra Correios — Operational Persistence

## Database role

PostgreSQL is the operational source of truth.

Sheets/XLSX/CSV are source, import, export or audit artifacts, not runtime
transactional state.

## Minimum model

Support at least:
- arquivo_importacao
- importacao
- linha_importada
- perfil_mapeamento
- profissional
- snapshot_cadastral
- confirmacao
- comunicacao
- oauth_connection
- outbox_email
- lote_comunicacao
- item_lote_comunicacao
- lote
- item_lote
- evento_auditoria

## Migrations

All schema changes are versioned migrations.

No manual production-only schema drift.

## Transactions

Business actions spanning records must be atomic.

Scheduling one confirmation email should transactionally create confirmation,
communication, audit event and outbox record, then COMMIT before any provider call.

## Transactional outbox

Never call Gmail/Resend inside the database transaction.

worker:
claim outbox → call provider → persist result → mark outcome

## Idempotency

Use stable idempotency keys and database unique constraints.

Do not claim distributed guarantees from in-memory locks or Sets.

## Confirmation consumption

Exactly one concurrent request may consume a pending, unexpired token.

Use an atomic conditional UPDATE ... RETURNING pattern.

## Lot locking

Prevent conflicting active communication/PPN lots at database level.

## Personal data

- recoverable sensitive values: authenticated encryption at rest;
- equality/deduplication: HMAC fingerprint;
- OAuth refresh tokens: encrypted at rest;
- keys: never in repo or browser.

## Audit

evento_auditoria is append-only and uses safe metadata.

## Tests

Before claiming distributed guarantees, test against a real PostgreSQL-compatible
integration environment.

Cover migrations, atomicity, constraints, outbox retry/claim, concurrent
confirmation, duplicate lot prevention and append-only audit.

## Out of scope

No real Gmail send, PPN send, production secrets or production migration
execution without explicit approval.
