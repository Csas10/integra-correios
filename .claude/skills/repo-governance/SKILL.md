---
name: repo-governance
description: Apply repository governance, branch isolation, safety gates and merge restrictions for the integra-correios project.
---

# Integra Correios — Repository Governance

## Purpose

Apply repository governance rules before modifying the Integra Correios repository.

Use this skill whenever creating, modifying, reviewing, testing, committing,
publishing or preparing a pull request.

## Repository

Repository:
Csas10/integra-correios

## Core rule

Never modify `main` directly.

Every implementation must start from the current approved `main` and use a
dedicated feature or fix branch.


## Mandatory workflow

1. Confirm current `main` SHA.
2. Confirm working tree is clean.
3. Create or use only the explicitly authorized branch.
4. Inspect existing implementation before changing code.
5. Keep the change within the authorized scope.
6. Run all required gates.
7. Audit changed files and resulting tree.
8. Publish only as Draft PR unless explicitly authorized otherwise.
9. Do not merge automatically.
10. Do not deploy to production automatically.

## Forbidden actions

Do not:

- push directly to `main`;
- merge a PR without explicit human authorization;
- mark a PR Ready automatically;
- deploy to production;
- create or alter production secrets;
- add `.env` files to Git;
- commit CPF, CNPJ, addresses, phones, emails or other real personal data;
- execute real PPN operations unless explicitly authorized;
- send real emails unless explicitly authorized;
- modify the Correios Golden Profile without homologation evidence;
- silently expand the scope of the current branch.

## Data policy

Fixtures and tests must use synthetic data only.

CPF, CNPJ and CEP must be treated as strings.

Never log:

- raw confirmation tokens;
- secrets;
- full CPF/CNPJ;
- full addresses unless required by an explicitly authorized operational flow.

## Branch isolation

One implementation branch should represent one auditable concern.

Do not combine:

- intake;
- persistence;
- mail provider;
- PPN orchestration;
- CRM/WhatsApp integration

in the same feature PR unless explicitly authorized.

## Required gates

Before publishing a PR:

- repository policy PASS;
- typecheck PASS;
- tests PASS;
- TypeScript build PASS;
- web build PASS;
- git diff --check PASS;
- secret scan PASS;
- no unintended PII PASS;
- working tree clean.

When applicable:

- Vercel Preview READY;
- CodeRabbit or independent review completed.

## Completion report

Always report:

- base SHA;
- branch;
- head SHA;
- tree SHA;
- files changed;
- tests executed;
- gate results;
- known limitations;
- out-of-scope items;
- whether any external action occurred.

## Fail closed

If authorization, configuration or scope is ambiguous, do not perform the
external or irreversible action.

Prepare the change safely and stop before the gated operation.