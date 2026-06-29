# CI Tools Vision

## The Problem

1. **Problem 1: Deploy previews are split across control planes.** Generated
   workflows, Nix shell tasks, provider CLIs, and workflow-report rendering can
   each define part of deploy behavior, which makes failures hard to classify
   and hard to fix safely.
2. **Problem 2: Provider failures are too often unstructured.** Raw stderr,
   provider-specific messages, and missing deploy URLs do not consistently
   become retry-aware records, telemetry, or actionable review output.
3. **Problem 3: Live provider confidence is hard to obtain without risk.** Real
   Netlify and Vercel checks can prove deployed artifacts work, but they must not
   expose secrets, overwrite normal previews, or block unrelated changes because
   of provider flake.
4. **Problem 4: CI output must stay useful under pressure.** Humans need compact
   terminal and PR-report output that surfaces blocking deploy problems first
   without duplicating noisy provider logs.

## The Vision

- One Effect-based `ci-tools` runtime owns deploy-preview semantics, workflow
  report records, retry classification, and telemetry.
- Generated workflows and Nix tasks remain stable entrypoints but act only as
  thin launchers into `ci-tools`.
- Provider adapters expose typed, schema-decoded boundaries for Netlify and
  Vercel while using provider CLIs only where direct upload/deploy APIs would be
  less reliable.
- Hermetic E2E proves the deploy boundary on every relevant change; live E2E
  adds provider confidence behind explicit guardrails.
- CLI output is compact, problems-first, and machine-collectable: humans see the
  deploy URL or typed failure summary, while PR automation consumes structured
  workflow-report records.

## What This Is Not

- This is not a replacement for GitHub Actions.
- This is not a provider-side CI/build system.
- This is not a place to store provider project identifiers, account details, or
  secret values.
- This is not a rich TUI; deploy commands are automation-first CLI surfaces.

## Success Criteria

1. Deploy preview outcomes are emitted as exactly one typed workflow-report
   record per target.
2. Missing credentials, missing artifacts, provider lookup failures, invalid
   output, unsafe live aliases, and verification failures decode to explicit
   error tags.
3. Netlify and Vercel deploy previews both run through the same `ci-tools`
   domain model and thin task-launcher contract.
4. Required E2E uses fake providers and the real task/CLI boundary.
5. Live E2E can deploy and verify a local static fixture without committing
   provider identifiers or secret values.
6. Human CLI output stays short and actionable while structured records preserve
   detailed diagnostics for PR reporting.
