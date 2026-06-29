# CI Tools Requirements

## Context

This document is constrained by [vision.md](./vision.md) and is implemented by
[spec.md](./spec.md). Terms are defined in [glossary.md](./glossary.md).

## Assumptions

- **A01 Local artifact authority:** Deploy previews upload artifacts already
  produced by repository tasks; provider-side CI/build systems are outside this
  system.
- **A02 Generated workflow authority:** GitHub workflow YAML is generated from
  Genie sources and must not be hand-edited.
- **A03 Provider credentials at process edge:** Secret values enter only through
  runtime environment variables or repository secrets and are never committed to
  the public repository.
- **A04 External provider flake:** Netlify and Vercel can be unavailable or slow
  independently of repository correctness.

## Acceptable Tradeoffs

- **T01 CLI fallback for uploads:** Provider CLI upload/deploy commands are
  acceptable when direct API implementation would require reimplementing fragile
  provider-specific file upload semantics.
- **T02 Non-required live E2E:** Live provider checks may be non-required so
  unrelated PRs are not blocked by external provider availability.
- **T03 Compact human output:** Deploy commands may keep stdout terse when all
  detailed diagnostics are available in workflow-report records and logs.

## Requirements

### Must Centralize Deploy Semantics

- **R01 Single deploy runtime:** Netlify and Vercel deploy-preview behavior must
  run through `@overeng/ci-tools`.
- **R02 Thin launchers:** Nix deploy tasks and generated workflow steps must
  preserve stable entrypoint names while delegating provider semantics to
  `ci-tools`.
- **R03 Provider parity:** Netlify and Vercel must share the same deploy input,
  deploy result, failure taxonomy, retryability, workflow-report, and telemetry
  concepts.

### Must Use Effect Boundaries

- **R04 Effect CLI entrypoint:** The `ci-tools` process entrypoint must run via
  the Effect runtime and provide required Node, HTTP, telemetry, and CLI layers.
- **R05 Tagged expected errors:** Expected deploy failures must be represented by
  tagged Effect errors with contextual fields.
- **R06 Schema-decoded data:** Provider responses, deploy inputs, deploy
  results, workflow-report records, task-output payloads, and telemetry
  attributes must decode through Effect schemas before they cross a boundary.
- **R07 Platform HTTP:** Provider API lookup and live verification HTTP requests
  must use the Effect platform HTTP client.
- **R08 Command failures as records:** Provider CLI fallback failures must become
  typed deploy failures and workflow-report records instead of uncaught defects.

### Must Keep CLI Output Actionable

- **R09 Problems first:** Failure output must surface the blocking problem before
  low-level provider detail.
- **R10 Structured diagnostics:** Detailed deploy diagnostics must be carried in
  workflow-report records using the `WORKFLOW_REPORT_V1:` marker.
- **R11 Terse success output:** Successful deploy commands must print a stable
  single-line final URL summary for humans and automation logs.
- **R12 No secret leakage:** CLI stdout, stderr, workflow-report records, task
  output, and telemetry must not include raw provider tokens or bypass secrets.

### Must Support Providers Safely

- **R13 Local artifact deploys:** Provider deploys must upload local artifacts
  and must not trigger provider-side build systems.
- **R14 Alias modes:** Deploy modes must map to deterministic alias behavior for
  production, pull request, draft, and preview deploys.
- **R15 API-first diagnostics:** Provider project/site lookup must use provider
  APIs before upload/deploy so credential and project failures are classified
  early.
- **R16 Vercel scope safety:** Vercel deploys for team projects must support an
  explicit CLI scope environment variable.
- **R17 Task output contract:** Deploy task launchers must expose final and raw
  deploy URLs through `DEVENV_TASK_OUTPUT_FILE` when that file is provided.

### Must Be Verified End to End

- **R18 Hermetic task E2E:** Required E2E must exercise the real task launcher,
  real `ci-tools` CLI, and fake providers without external credentials.
- **R19 Provider fake E2E:** Provider tests must cover success, lookup failure,
  unauthorized credentials, invalid provider output, unsafe alias refusal, and
  redaction.
- **R20 Live E2E guardrails:** Live E2E must require an explicit shared-project
  mode and reserved alias namespace before deploying to shared provider projects.
- **R21 Live marker verification:** Live E2E must fetch the final deploy URL and
  verify marker content from the uploaded local artifact.
- **R22 Cleanup reporting:** Live E2E cleanup must be best effort and recorded,
  but cleanup failure must not mask deploy or marker verification failure.

### Must Preserve Public-Repo Safety

- **R23 No committed provider identifiers:** Provider project ids, team ids,
  account names, and secret references used for live E2E must not be committed
  into this public repository.
- **R24 Generated-file discipline:** Generated workflow files must be updated
  through their `.genie.ts` sources.
- **R25 VRS freshness:** Vision, requirements, spec, glossary, experiments, and
  decisions must describe the current system rather than a stale migration plan.
