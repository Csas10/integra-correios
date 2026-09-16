---
name: web-operational-flow
description: Implement the Integra Correios web cockpit for import, validation, communication lots, confirmations and operational status with human gates.
---

# Integra Correios — Web Operational Flow

## Main areas

1. Entrada
2. Validação
3. Confirmação PF
4. Pré-postagem
5. Retorno
6. Gestão / Integrações

## Entrada

Allow upload XLSX/CSV, origin selection, worksheet/header selection, mapping
suggestions, explicit mapping confirmation, normalized preview and blocking
validation issues.

Import must never trigger email automatically.

## Validation

Show aggregate counts and row-level status.

Mask PII by default.

No silent source-data mutation.

## PF communication

Support APTO_CONTATO queue, record selection, communication lot creation,
message preview, deliberate send confirmation and progress/status.

Sending enqueues outbox work through the API.

## Confirmation

The UI must distinguish client validation, server persistence and successful
institutional confirmation.

Never show final success before the server persists it.

## Gmail integration UI

May expose connected/disconnected, mailbox identity, capability,
reconnect/revoke and last success/failure.

Never expose OAuth tokens or secrets.

## Pre-posting

Only APTO_PREPOSTAGEM records are selectable.

Backend revalidates eligibility.

## Status

Communication lots should show queued, sending, sent, failed, confirmed,
updated, waiting and pending review.

Communication lots and PPN lots are different aggregates.

## API boundary

Browser calls authenticated backend APIs.

Browser must not hold Gmail privileged credentials, database credentials or
authoritative state-transition logic.

## UX safety

Before irreversible external actions, show record count, scope and provider and
require explicit confirmation.

Prevent accidental double submit.

## Tests

Cover upload/mapping, blocked invalid mapping, masked PII, batch selection,
preview, no auto-send, send confirmation, server errors, confirmation wording,
responsive behavior and accessibility.
