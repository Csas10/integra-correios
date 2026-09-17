---
name: security-privacy
description: Enforce privacy, PII, secret, token, upload, logging and security controls for the Integra Correios project.
---

# Integra Correios — Security & Privacy

## Purpose

Use this skill whenever a change touches personal data, documents, addresses,
emails, phones, CPF/CNPJ, uploads, OAuth, secrets, tokens, logs or external
integrations.

This skill is defensive and fail-closed.

## Core principles

- Minimize personal data at every layer.
- Keep secrets server-side.
- Never use real personal data in tests, fixtures, seeds or screenshots.
- Never log raw secrets, OAuth tokens, confirmation tokens, full CPF/CNPJ,
  or full addresses unless an explicitly approved operational requirement demands it.
- Preserve original data and record corrections as new audited facts.
- Never silently overwrite source data.

## CPF/CNPJ

Treat CPF/CNPJ as strings.

If the raw value must be recoverable operationally, store it encrypted at rest.

For equality/deduplication, use a keyed HMAC fingerprint such as HMAC-SHA-256
with a server-side secret.

Do not use plain SHA-256 of CPF/CNPJ as a privacy control.

UI presentation must be masked by default.

## Confirmation tokens

- Generate at least 256 bits of cryptographically secure random entropy.
- Store only a cryptographic hash of the token.
- Never place CPF/CNPJ or predictable identifiers in confirmation URLs.
- Tokens must expire.
- Consumption must be atomic in persistent storage.
- Reuse after successful consumption must be rejected.

## OAuth and credentials

- OAuth client secrets, refresh tokens and provider secrets are server-side only.
- Persist refresh tokens encrypted at rest.
- Never expose secrets through VITE_, browser bundles, query strings or logs.
- Request the minimum provider scope required by the feature.

## Upload security

- enforce byte, row, column and sheet limits;
- accept only explicitly allowed formats;
- reject executable/macro content;
- never execute formulas;
- validate structural content independently of filename;
- calculate SHA-256 of the original artifact for audit;
- do not store user uploads in the repository.

## External actions

Always require an explicit human gate for:
- sending real email;
- changing production secrets;
- enabling new OAuth scopes;
- posting to Correios PPN;
- changing confirmed cadastral data;
- promoting incomplete records to APTO_PREPOSTAGEM.

## Tests

Use synthetic data only.

Cover masking, redaction, expired/reused tokens, atomic consumption, upload
limits, unsupported files, numeric CPF/CNPJ/CEP risk and invalid OAuth/provider
configuration.
