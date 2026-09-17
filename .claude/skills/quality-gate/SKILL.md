---
name: quality-gate
description: Run and verify the mandatory repository, test, build, security and review gates before declaring an integra-correios change complete.
---

# Quality Gate

Before declaring an implementation complete, run:

npm run policy:repo
npm run typecheck
npm test
npm run build
npm run build:web
git diff --check

Also verify:

- secret scan;
- PII fixture scan;
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