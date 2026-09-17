---
name: legacy-regression
description: Use the homologated Apps Script legacy baseline as a regression oracle without making it an operational runtime dependency.
---

# Integra Correios — Legacy Regression

## Role of legacy

Legacy is a specification oracle and regression source, not target runtime
architecture.

Do not introduce new runtime dependencies on Sheets or Apps Script just to
reproduce legacy behavior.

## Baseline

Preserve the approved baseline under legacy/apps-script/.

Treat V1.8.5 as baseline unless a later approved version is documented.

## Regression pattern

same controlled input
├── legacy generation
└── V2 generation
      ↓
semantic comparison

## Semantic comparison

Ignore irrelevant serialization details such as JSON property order.

Require operational equivalence for origin, identity, service, format, weight,
AR, RR, declaration, recipient, dimension omission, lot membership and
reconciliation outcome.

## Return behavior

Preserve proven balanced JSON extraction, flattened JSON plus text handling,
deterministic identity, leading-zero preservation and correct rejection reason
cleanup.

## Do not copy bad behavior blindly

If legacy conflicts with approved homologation evidence, security/privacy rules,
domain invariants or current tested contracts, document the difference and
require human decision.

## Fixtures

Repository tests use synthetic fixtures only.

Historical operational artifacts with personal data must not be committed.

## Acceptance

Regression report must state fixture/input, legacy result, V2 result, allowed
differences, blocked differences and final status.
