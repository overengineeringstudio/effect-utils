# Vision: CI Tools

## The Problem

### Problem 1: CI control-plane behavior is split across weak boundaries

CI deploy previews, report records, provider diagnostics, retries, and task
wiring are currently spread across generated workflow snippets, Nix task
modules, shell scripts, and TypeScript helpers. This makes it hard to tell which
layer owns behavior when a provider fails.

### Problem 2: Provider failures are not modeled as domain events

Deploy failures can collapse into raw stderr and a non-zero exit code. That is
enough for manual debugging after the fact, but not enough for typed retry
policy, structured PR comments, or telemetry queries that distinguish
authentication errors, provider lookup failures, malformed output, and true
deployment failures.

### Problem 3: Deploy previews must stay local-build native

The repository's build and test model is local and reproducible. External
providers are deployment targets, not build systems. A preview pipeline that
implicitly relies on provider CI/build behavior weakens that boundary and makes
failures harder to reproduce locally.

### Problem 4: Live provider coverage needs guardrails

Hermetic tests catch control-plane regressions, but live provider tests catch
auth/API drift. Live tests against shared provider projects can pollute preview
state or overwrite human-facing aliases unless the tool enforces an explicit
safe namespace.

### Problem 5: The package name no longer matches the intended domain

`@overeng/workflow-report` began as a reporting package, but the desired source
of truth now includes CI deploy semantics, error modeling, retry, diagnostics,
and observability. The package and binary names should describe that broader
CI control-plane role.

## The Vision

- **CI behavior has one typed runtime source of truth.** Deploy execution,
  provider diagnostics, failure classification, retry, workflow records, and
  telemetry live in an Effect-based CI tools runtime.
- **Generated workflow and Nix task layers are thin launchers.** They pass
  declared configuration to `ci-tools` and preserve stable task names, but they
  do not own provider behavior.
- **Provider failures are structured, observable, and actionable.** Failures are
  represented as typed domain errors, emitted as workflow-report records, and
  traced with stable attributes.
- **Deploy previews use local artifacts only.** Netlify and Vercel receive
  locally built static directories; provider CI/build systems are not part of
  the preview path.
- **E2E coverage is layered.** Hermetic fake-provider tests run as required CI;
  live provider tests run in normal CI as non-required checks with explicit
  shared-project guardrails.

## What This Is Not

- Not a general-purpose CI engine or replacement for GitHub Actions.
- Not a general-purpose deployment platform abstraction.
- Not a replacement for Netlify or Vercel provider APIs.
- Not a provider build-system integration. Providers host local artifacts; they
  do not build repository source for this pipeline.
- Not a home for private provider project identifiers or secrets.

## Success Criteria

1. The deploy preview control plane can classify provider failures without
   reading raw CI logs manually.
2. Netlify and Vercel deploy preview behavior is owned by the `ci-tools` Effect
   runtime rather than shell-generated provider logic.
3. Every deploy attempt emits a structured success, skipped, or failure record
   suitable for workflow-report comments.
4. Every deploy attempt produces telemetry spans with stable provider, target,
   mode, attempt, and error-kind attributes.
5. Required CI proves the `ci-tools` binary and generated task integration
   through hermetic fake-provider E2E tests.
6. Non-required live CI deploys local static fixtures to provider projects
   without invoking provider CI/build systems and without using unguarded
   production aliases.
