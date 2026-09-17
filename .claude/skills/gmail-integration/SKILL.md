---
name: gmail-integration
description: Implement the Google Workspace Gmail API adapter and controlled web email workflow for Integra Correios.
---

# Integra Correios — Gmail Integration

## Architecture

Browser
→ Integra Correios API
→ PostgreSQL/outbox
→ worker
→ GmailMailGateway
→ Gmail API

Never call Gmail API directly from browser code.

## Provider abstraction

Implement Gmail behind the existing MailGateway contract.

Keep Google SDK types inside the adapter.

## OAuth

Use server-side OAuth 2.0 authorization code flow.

Initial sending scope:
https://www.googleapis.com/auth/gmail.send

Do not request inbox-reading scopes in the initial feature.

Any future reply-reading scope requires a separate reviewed feature.

## Credentials

Keep OAuth client secret, refresh token and access token server-side.

Persist refresh tokens encrypted at rest.

Never expose tokens in browser bundles or logs.

## Connection UI

May show provider, connected/disconnected, mailbox identity, granted capability,
connected_at, last successful send and revoke/reconnect.

Never show secrets or refresh tokens.

## Sending

The operator prepares a communication lot, previews it and explicitly confirms
the send.

The API enqueues outbox work.

The worker performs Gmail API calls.

Persist communication_id, gmail_message_id, gmail_thread_id when returned,
sent_at, normalized status, retry count and last error category.

## Message construction

Use the versioned PF confirmation template.

Do not include CPF/CNPJ in the email body.

Validate headers and prevent CRLF/header injection.

## Retry

Retry only transient failures, with bounded exponential backoff and jitter.

Permanent auth, recipient or policy failures stop retrying and surface to the
operator.

## Idempotency

Persistent idempotency prevents duplicate logical messages.

Do not rely only on Gmail/provider behavior.

## Reply handling

Initial scope may keep manual mailbox reply as fallback.

Do not auto-update canonical data from free-form email text.

## Tests

Mock Gmail at adapter boundaries.

Cover token refresh, revoked OAuth, MIME/message encoding, header injection,
success, transient retry, permanent failure, duplicate outbox attempt and no
browser secret exposure.
