# Buck Evidence and OpenTelemetry Requirements

This subsystem defines native evidence, its observational adapter, and
failure-capable verification. It refines BUCK-R11 through BUCK-R15.

## Assumptions

- **BUCK.OBS-A01 Native evidence authority:** Buck's build report, event log,
  invocation ID, and supported derived queries remain execution truth.
- **BUCK.OBS-A02 Control-plane trace:** The calling task or CI control plane
  owns the trace root, retention, sampling, routing, and admission decision.
- **BUCK.OBS-A03 Collector export:** OTLP delivery policy belongs to the
  OpenTelemetry SDK and Collector path, not the Buck action result.

## Acceptable Tradeoffs

- **BUCK.OBS-T01 Versioned rich decoder:** Rich event-log interpretation may be
  bound to one Buck version and degrade to stable evidence fields when the
  decoder does not admit a new version.
- **BUCK.OBS-T02 Optional observer:** Direct invocation may remain the permanent
  baseline even when it provides less synchronous telemetry. An interposed
  observer is admitted only for a measured capability gap and is removed when
  caller-owned tracing or native-evidence processing closes that gap. See
  [decision 0011](../.decisions/0011-direct-native-evidence-observation.md).

## Requirements

### Must preserve execution truth

- **BUCK.OBS-R01 Native capture:** Authoritative invocations must request and
  retain a build report, event log, and invocation identity under an explicit
  retention policy.
- **BUCK.OBS-R02 Lossless correlation:** Normalized telemetry must link to the
  native evidence and configured operation without replacing or rewriting it.
- **BUCK.OBS-R03 Honest interpretation:** Unsupported evidence versions,
  incomplete files, and unavailable comparison dimensions must be represented
  explicitly; no exact cause may be inferred without causal proof.

### Must provide first-class telemetry

- **BUCK.OBS-R04 Trace propagation:** The control plane must represent the Buck
  invocation below its task span using W3C trace context. Any interposed observer
  must preserve that context and parentage.
- **BUCK.OBS-R05 Stable semantic conventions:** Span names, result classes,
  evidence links, platform identity, cache outcome, and product correlation must
  be versioned and align with OpenTelemetry CI/CD conventions where applicable.
- **BUCK.OBS-R06 Cardinality control:** Metrics must contain only bounded
  operation kind, result class, platform class, and cache class. Labels,
  invocation IDs, digests, paths, and evidence URLs must not be metric labels.
- **BUCK.OBS-R07 Sanitization:** Raw argv, environment values, host paths, and
  repository-private identities must be omitted or transformed by explicit
  policy before export.
- **BUCK.OBS-R08 Export independence:** OTLP failure must not change Buck's exit
  code, stdout, stderr, cancellation, or signal behavior.

### Must prove the observation and authority seam

- **BUCK.OBS-R09 Wrapper justification and transparency:** Direct Buck is the
  baseline. Any interposed observer must identify the unmet requirement and
  prove parity for arguments, environment policy, exit status, signals,
  cancellation, stdout, stderr, and native evidence.
- **BUCK.OBS-R10 Failure-capable E2E:** Verification must capture a real task
  trace through Buck and independent Nix import, plus negative controls for
  missing evidence, failed export, malformed evidence, and import rejection.
- **BUCK.OBS-R11 No-verdict semantics:** Missing required evidence yields no
  verdict. Consumer admission may hold, while the recorded Buck result remains
  unchanged.
