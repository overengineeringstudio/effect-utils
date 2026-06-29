# Deploy Task Fake-Provider E2E

## Status

Passed on 2026-06-29.

## Purpose

Issue #868 requires hermetic E2E coverage through the real binary and task
boundary. Before `ci-tools deploy` exists, the current deploy task boundary is
the generated Nix shell task. This experiment proves the existing Netlify and
Vercel task modules can be exercised end to end with fake provider CLIs while
still using the real module-generated shell scripts.

## Scenario

`nix/devenv-modules/tasks/shared/tests/deploy-task-e2e.test.sh` evaluates the
real `netlify.nix` and `vercel.nix` modules with fake provider package paths,
extracts the generated task scripts, and runs them against local static
fixtures.

Coverage:

- Netlify PR deploy success emits a final alias URL, `DEVENV_TASK_OUTPUT_FILE`
  metadata, and a workflow-report record.
- Netlify unauthorized/project lookup failure prints provider diagnostics and
  preserves the provider exit code without leaking the fake token.
- Netlify malformed provider JSON fails before emitting a success record.
- Netlify PR mode without a PR number fails before calling the provider.
- Vercel static PR deploy packages local output as Build Output API v3, calls
  `vercel deploy --prebuilt`, assigns the PR alias, emits task output metadata,
  and emits a workflow-report record.
- Vercel CLI output without a deploy URL fails before emitting a success record.
- Vercel missing local static output fails before calling the provider.

The test uses fake tokens, fake provider CLIs, fake provider IDs, and local
fixtures only. It performs no network access and does not require real provider
credentials.

## Verification

```bash
devenv tasks run devenv-modules:test --no-tui
```

Result: passed.

## Follow-up

This is a bridge E2E for the current task-owned deploy boundary. The long-term
Phase 6 target still needs equivalent fake-provider E2E through `ci-tools
deploy` after the hard rename and deploy domain model exist.
