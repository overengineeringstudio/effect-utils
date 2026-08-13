# Buck Evidence and Verification Requirements

## Context

This subsystem defines the evidence needed to explain and admit Buck graph,
execution, cache, artifact, and performance claims. It does not assign build or
deployment authority; it makes the observations used by those decisions
explicit, comparable, and auditable.

## Assumptions

- **BUCK.EVID-A01 Native authority:** Buck event logs and build reports are the
  authority for what Buck observed and executed. Derived records may summarize
  and join that evidence but may not replace or contradict it.
- **BUCK.EVID-A02 Generated graph authority:** Generator-owned graph declarations and
  their checked-in projections define intended graph topology. Execution
  success alone does not prove that the generated graph is fresh.
- **BUCK.EVID-A03 Layered evidence:** Fast fixtures protect contracts on every relevant
  change. Expensive, repeated, cross-host, or destructive proofs may run on a
  broader admission lane.

## Acceptable Tradeoffs

- **BUCK.EVID-T01 Selective execution:** CI may execute only affected graph compilers
  and target shards when a complete, fail-closed graph audit justifies the
  selection.
- **BUCK.EVID-T02 Sanitized receipts:** Public CI may retain a sanitized,
  content-addressed receipt instead of unrestricted native logs when the
  receipt preserves evidence provenance and observation completeness.

## Requirements

### Must preserve native evidence

- **BUCK.EVID-R01 Native evidence retention:** Every authoritative Buck invocation
  must retain or content-address its event log and build report and record the
  Buck invocation identity, command kind, requested targets, exact revision,
  platform, status, and duration.
- **BUCK.EVID-R02 Complete observation:** A receipt must state whether event-log,
  build-report, action, output, cache, and materialization observations are
  complete. Missing or unparseable evidence must be represented explicitly and
  must not be converted to an empty observation or zero measurement.
- **BUCK.EVID-R03 Outcome separation:** Evidence must distinguish DICE reuse, local
  cache hit or miss, remote cache hit or miss, local execution, remote
  execution, materialization-only work, failure, cancellation, and unknown
  outcome.
- **BUCK.EVID-R04 Safe derivation:** Public receipts must exclude credentials, raw
  environments, unrestricted command lines, host-private paths, and other
  sensitive data. Redaction must not remove the identities needed to join a
  receipt to its native evidence.

### Must preserve verdict semantics

- **BUCK.EVID-R05 Three-way verdict:** Every proof must report exactly one semantic
  verdict: `pass`, `fail`, or `no-verdict`. Execution dispositions such as
  skipped, cancelled, unavailable, timed out, or incomplete must remain
  separate from the semantic verdict.
- **BUCK.EVID-R06 No-verdict integrity:** Missing prerequisites, failed experimental
  controls, incomplete native observations, runner pressure, or infrastructure
  corruption must produce `no-verdict`. Such records must not be counted as
  passing or failing samples, establish parity, or advance admission.
- **BUCK.EVID-R07 Fail-closed policy:** When a required proof produces `no-verdict`,
  admission policy must select a proven fallback, require a rerun, or block the
  transition. The policy failure must not rewrite the underlying evidence as a
  product failure.

### Must prove causal invalidation

- **BUCK.EVID-R08 Harness sensitivity:** An invalidation harness used for admission
  must prove RED on a deliberately broken dependency edge or observation seam
  and GREEN on the corrected seam under the same mutation.
- **BUCK.EVID-R09 Exact controls:** Invalidation evidence must distinguish warm no-op,
  metadata-only, relevant-content, irrelevant-content, restoration,
  configuration, provenance, and error-producing changes and assert the exact
  affected action identities or an explicitly bounded action set.
- **BUCK.EVID-R10 Observable consequence:** A relevant mutation must change an
  independently observable output digest, behavior, diagnostic, or declared
  evidence field. Action execution alone is insufficient causal proof.
- **BUCK.EVID-R11 Restoration:** Mutation proofs must restore source bytes and
  relevant metadata, terminate or isolate their daemon state, remove temporary
  worktrees, and reproduce the original output identity before reporting
  completion.

### Must make benchmarks comparable

- **BUCK.EVID-R12 Comparable subjects:** A benchmark comparison must name the exact
  revisions, work contract, target set, tool versions, platform and runner
  class, cache treatment, isolation treatment, repetitions, warmups, and
  observation completeness for every subject.
- **BUCK.EVID-R13 Controlled phases:** Cold, warm, daemon-restart, relevant edit,
  irrelevant edit, and remote-cache phases may be compared only when their
  preconditions were successfully controlled. A failed clean, kill, seed, or
  cache-isolation control yields `no-verdict` for that phase.
- **BUCK.EVID-R14 Honest aggregation:** Benchmark summaries must exclude no-verdict
  samples, report the included and excluded counts and reasons, preserve raw
  observations, and avoid cross-engine conclusions unless equivalent work is
  independently established.

### Must audit generated topology

- **BUCK.EVID-R15 Derived graph index:** Every generated Buck projection must have a
  deterministic audit index derived from the authoritative semantic graph and
  projection metadata. The index may name owners, outputs, target labels,
  semantic inputs by role, compiler groups, platforms, and output digests, but
  must not redefine package or target semantics.
- **BUCK.EVID-R16 Complete selection:** A graph audit must map every relevant changed
  path to one or more freshness or execution shards. Unknown ownership,
  ambiguous ownership, an invalid graph record, or a missing output must select
  the conservative full check or fail closed.
- **BUCK.EVID-R17 Runtime-neutral contract:** A helper's semantic CLI, output schema,
  normalization, and error categories must be separable from its implementation
  runtime. Runtime replacement must invalidate helper-dependent actions and
  provenance without rewriting semantically unchanged graph projections.

### Must make CI decisions auditable

- **BUCK.EVID-R18 CI decision report:** Every CI selection must emit a deterministic
  report containing compared revisions, changed-path and graph-record digests,
  selected and skipped shards, reasons, fallback state, executed compilers,
  evidence references, and final verdict.
- **BUCK.EVID-R19 Stable admission meaning:** Required CI checks must represent stable
  semantic guarantees. Target shards, helper runtimes, and execution jobs may
  change without changing the meaning of the required check.
- **BUCK.EVID-R20 Evidence availability:** Sanitized receipts, graph-audit reports,
  CI decision reports, benchmark observations, and failure diagnostics must be
  retained long enough to review an admission or regression claim and must be
  uploaded on both success and failure when they exist.
