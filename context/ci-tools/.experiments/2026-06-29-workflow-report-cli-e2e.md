# Workflow-Report CLI Hermetic E2E

## Status

Passed on 2026-06-29.

## Purpose

Before the deploy runtime exists, the migration needs a small required E2E
foundation that proves the current workflow-report CLI can be exercised as a
real external binary boundary. This protects the compatibility behavior that
`ci-tools` must preserve during the hard rename.

## Scenario

`packages/@overeng/workflow-report/src/workflow-report.e2e.test.ts` spawns
`packages/@overeng/workflow-report/bin/workflow-report.ts` through `bun` and
uses temporary files to verify the real CLI can:

- collect a marked deploy-preview record into a bundle
- render a managed PR-comment body from that bundle
- write a visible summary without hidden managed state
- locate the existing managed comment ID from a comments payload

The test uses a fake provider record and placeholder URLs only. It does not use
provider credentials, provider project identifiers, or network access.

## Verification

```bash
devenv tasks run test:workflow-report --no-tui
```

Result: passed.

## Follow-up

This is not the full deploy-provider E2E required by issue #868. It establishes
the external-process workflow-report compatibility boundary that the future
`ci-tools` binary must continue to satisfy while provider fake E2E is added.
