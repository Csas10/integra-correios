---
name: quality-gate
description: Run and verify the mandatory repository, test, build, security and review gates before declaring an integra-correios change complete.
---

# Quality Gate

Before declaring an implementation complete, run:

npm run policy:repo
npm run security:secrets
npm run security:pii
npm run typecheck
npm test
npm run build
npm run build:web
git diff --check

The two security commands are reproducible guardrails (identical local
and CI, no external calls, no telemetry). Rules, allowlist and known
limitations are documented in `docs/security/scan-rules.md`. They are
heuristics — not absolute proof of absence of secrets/PII.

Also verify:

- clean working tree;
- expected changed-file scope;
- branch based on the expected main SHA.

For a published PR:

- keep Draft by default;
- verify CI;
- verify Vercel Preview when applicable;
- obtain independent review;
- address actionable findings before merge.

Never equate a skipped CodeRabbit check with a completed review.