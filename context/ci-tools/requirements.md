# CI Tools Requirements

## Context

These requirements serve the [vision](./vision.md). The initial migration
renames `@overeng/workflow-report` to `@overeng/ci-tools` and expands the
runtime source of truth from workflow-report rendering into deploy preview
execution, reporting, provider diagnostics, retry, and telemetry.

## Assumptions

- **A01 Existing report contract:** The existing `WorkflowReportRecord` wire
  contract remains the compatibility boundary for PR comments and managed
  workflow-report state.
- **A02 Effect runtime foundation:** CI tools can use the repo's established
  Effect CLI, `@effect/platform` command/http services, schema-backed errors,
  retry schedules, and `@overeng/utils` telemetry front door.
- **A03 Local artifact ownership:** Storybook and comparable preview artifacts
  are built locally by repository tasks before provider upload.
- **A04 Provider project reuse:** Live E2E may reuse existing provider projects
  when the alias namespace is explicitly reserved for CI-tools E2E and enforced
  by the tool.
- **A05 Public repository boundary:** VRS docs and code in this repository must
  not contain private provider project identifiers, account details, tokens, or
  private-repo facts.

## Acceptable Tradeoffs

- **T01 API-first, CLI fallback:** Provider adapters prefer direct provider APIs
  for operations whose semantics are straightforward. They may fall back to
  provider CLIs for upload/deploy behavior when reproducing provider-specific
  semantics directly would add disproportionate risk.
- **T02 One large migration PR:** A single PR may combine the hard rename,
  deploy core, Netlify provider, Vercel provider, generated task rewiring, and
  E2E coverage, provided the merge bar leaves no provider half-migrated.
- **T03 Live E2E is non-required:** Live provider E2E runs in normal CI but is
  not a required check. Required CI relies on hermetic fake-provider E2E for
  deterministic merge blocking.
- **T04 Shared provider projects need explicit guards:** Reusing production
  preview projects is acceptable only when E2E mode requires an explicit shared
  project flag and validates a reserved alias prefix before deploying.

## Requirements

### Must establish the runtime source of truth

- **R01 Package identity:** `@overeng/workflow-report` must be hard-renamed to
  `@overeng/ci-tools`; generated package metadata, imports, binary names, Nix
  build wiring, and generated CI call sites must use the new identity.
- **R02 Thin launchers:** Generated workflow steps and Nix deploy tasks must
  preserve stable task names and pass configuration to `ci-tools`, but provider
  execution, classification, retry, reporting, and telemetry must live in
  TypeScript/Effect code.
- **R03 Report compatibility:** Existing workflow-report bundle, render, and
  managed-comment behavior must remain available under `ci-tools`.

### Must model deploy previews explicitly

- **R04 Deploy input schema:** Deploy invocations must decode a versioned,
  typed input that includes provider, target, mode, artifact directory, optional
  alias, provider identity references, CI metadata, and E2E mode.
- **R05 Deploy result schema:** Successful deploys must produce a typed result
  containing provider, target, mode, raw deploy URL, final URL, deploy id when
  available, alias when used, timestamps, and attempt count.
- **R06 Deploy failure taxonomy:** Expected deploy failures must be tagged
  domain errors. The initial taxonomy must distinguish missing auth,
  unauthorized auth, missing build output, provider project lookup failure,
  invalid provider output, provider command/API failure, unsafe E2E alias, and
  verification failure.
- **R07 Retryability is data:** Retry policy must be derived from the typed
  failure, not from ad hoc exit-code handling. Non-retryable failures must not
  be retried.

### Must support Netlify and Vercel parity

- **R08 Netlify provider parity:** Netlify deploy previews must support the
  current Storybook preview modes, aliases, local static directory upload,
  provider diagnostics, structured success/failure records, and retry policy.
- **R09 Vercel provider parity:** Vercel deploy previews must support the
  current local prebuilt/static deploy behavior, aliasing, project/team
  configuration, structured success/failure records, and retry policy.
- **R10 Provider API preference:** Provider adapters must use direct APIs for
  diagnostics, project/site lookup, alias validation, and cleanup when those
  operations are available and stable. CLI fallback must be justified at the
  adapter boundary.
- **R11 No provider builds:** Neither Netlify nor Vercel integration may invoke
  provider CI/build systems for this preview pipeline. All deployable content
  must come from local artifact directories.

### Must make failures observable

- **R12 Failure records:** Every skipped or failed deploy must emit a
  `WorkflowReportRecord` with `status` `skipped` or `failure` and a structured
  data payload containing error kind, retryability, attempt count, provider,
  target, mode, and sanitized diagnostics.
- **R13 Success records:** Every successful deploy must emit a
  `WorkflowReportRecord` with the primary preview URL and structured provider
  metadata.
- **R14 Redaction:** Workflow records, logs, and telemetry must not include
  provider tokens, raw secret values, or sensitive provider account details.
- **R15 Telemetry spans:** Deploy core, provider operation, and provider attempt
  paths must emit schema-backed OTEL spans with stable low-cardinality
  attributes for provider, target, mode, attempt number, status, and error kind.

### Must be tested end to end

- **R16 Hermetic E2E:** Required CI must exercise the real `ci-tools` binary and
  generated task boundary using fake provider adapters or fake provider CLIs.
- **R17 Live E2E:** Normal CI must include non-required live Netlify and Vercel
  E2E jobs that deploy local static fixtures, verify the served content, and
  emit workflow-report records.
- **R18 Shared-project guardrails:** Live E2E against shared provider projects
  must require an explicit shared-project flag, validate an alias prefix
  reserved for CI-tools E2E, and refuse deployment when the alias is outside
  that namespace.
- **R19 Cleanup evidence:** Live E2E must attempt cleanup when provider APIs
  support it. Cleanup failure must be recorded as degraded evidence but must not
  mask the deploy/verify result.

### Must remain reviewable and maintainable

- **R20 No half-migrated provider:** A PR that claims the hard rename and deploy
  migration must leave both Netlify and Vercel on the new `ci-tools` runtime
  path, or explicitly keep the old path as a documented rollback gate rather
  than an accidental second source of truth.
- **R21 Generated artifact discipline:** Generated files must be updated by
  editing `.genie.ts` sources and running Genie, not by direct edits.
- **R22 Public-safe docs:** The VRS and issue tracker may describe required
  secret names and provider capabilities, but must not commit real secret
  values or private provider identifiers.
