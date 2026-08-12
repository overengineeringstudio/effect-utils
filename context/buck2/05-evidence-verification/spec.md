# Buck Evidence and Verification Spec

This document specifies native Buck evidence capture, derived receipts,
causal invalidation proof, benchmark comparison, generated graph audit, and CI
decision reporting. It builds on [requirements.md](./requirements.md).

Status: **Draft**

## Scope

This subsystem defines evidence and verification contracts. It does not define
the package graph, build rules, artifact format, remote-cache service, or
deployment authority. Those systems consume the verdicts and evidence
references defined here.

## Requirement Trace

| Section                    | Requirements                        |
| -------------------------- | ----------------------------------- |
| Evidence model             | BUCK.EVID-R01 through BUCK.EVID-R07 |
| Causal invalidation        | BUCK.EVID-R08 through BUCK.EVID-R11 |
| Benchmark protocol         | BUCK.EVID-R12 through BUCK.EVID-R14 |
| Generated graph audit      | BUCK.EVID-R15 through BUCK.EVID-R17 |
| CI reporting and retention | BUCK.EVID-R18 through BUCK.EVID-R20 |

## Evidence Model

Native evidence remains authoritative; a receipt is a safe index and summary.

```text
Buck invocation
  +-- event log -------- execution, reuse, cache, materialization
  +-- build report ----- invocation, configured targets, outputs
  `-- closure evidence - generated dependency and tool identities
              |
              v
       sanitized receipt
              |
              v
       evidence envelope
```

### Evidence envelope

Every proof or benchmark publishes an envelope with this logical schema:

```json
{
  "schema": "buck-evidence-envelope/v1",
  "subject": {
    "revision": "40-character-git-sha",
    "contract": "package-evidence/v1",
    "platform": "x86_64-linux",
    "runnerClass": "linux-x86-64"
  },
  "result": {
    "verdict": "pass",
    "executionDisposition": "completed",
    "observation": "complete",
    "reasons": []
  },
  "evidence": [
    {
      "kind": "buck-run-receipt/v1",
      "digest": "sha256:...",
      "path": "receipts/run-id/receipt.json"
    }
  ]
}
```

`verdict` is one of `pass`, `fail`, or `no-verdict`.
`executionDisposition` is one of `completed`, `skipped`, `cancelled`,
`timed-out`, `unavailable`, or `incomplete`. The disposition explains what
happened operationally; it does not replace the verdict.

`observation` is `complete` only when every evidence source required by the
named contract was present, parsed, and semantically understood. Otherwise it
is `incomplete`, and `reasons` names each missing or invalid source.

### Verdict derivation

```text
required observations complete?
  |
  +-- no ------------------------------> no-verdict
  |
  `-- yes
       |
       +-- invariant violated ---------> fail
       |
       `-- invariant satisfied --------> pass
```

| Condition                                 | Verdict      | Policy consequence                     |
| ----------------------------------------- | ------------ | -------------------------------------- |
| Invariant observed and satisfied          | `pass`       | May contribute to admission            |
| Invariant observed and violated           | `fail`       | Blocks or triggers rollback            |
| Required evidence missing or unparseable  | `no-verdict` | Rerun, fallback, or block              |
| Environmental prerequisite unavailable    | `no-verdict` | Rerun elsewhere or use proven fallback |
| Experimental control fails                | `no-verdict` | Do not interpret measured phase        |
| Process crashes before observing the seam | `no-verdict` | Diagnose infrastructure/tool failure   |

A required CI check may exit unsuccessfully because it cannot obtain a
verdict. Its evidence envelope still records `no-verdict`; consumers must not
reclassify it as a semantic failure.

### Sanitized receipt

A `buck-run-receipt/v1` record contains:

- launcher run ID and Buck invocation ID;
- command kind and canonical requested target labels;
- start, end, and duration;
- Buck machine version;
- content descriptors for the event log and build report;
- completeness and parse status for required native queries;
- configured outputs and Buck digests;
- closure evidence descriptors;
- normalized action identities, outcomes, executors, and durations;
- outcome counts separated by category;
- materialized record, file, and byte counts; and
- an explanation status of `exact`, `partial`, or `unknown`.

The receipt never copies raw argument vectors, environments, reproducer
commands, unrestricted stderr, or absolute host paths. High-cardinality values
such as invocation IDs, revisions, labels, and digests remain artifact or trace
fields and are not metric labels.

## Causal Invalidation

An admission-grade harness proves both the target behavior and its own ability
to detect a missing dependency edge.

```text
1. Install known-bad graph fixture with one result-affecting edge absent.
2. Establish a controlled baseline.
3. Mutate the absent input.
4. Observe stale reuse and require the harness to report RED.
5. Restore the input and install the corrected graph edge.
6. Repeat the same mutation.
7. Observe the exact affected actions and changed consequence; report GREEN.
8. Restore bytes, metadata, daemon state, worktree state, and output identity.
```

RED and GREEN use the same target, mutation, isolation policy, and observation
queries. A harness that cannot distinguish the two is not evidence, even when
its normal case exits successfully.

### Mutation matrix

| Mutation              | Required observation                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| Warm no-op            | Zero actions and stable output digest                                   |
| Metadata-only         | Zero actions and stable output digest                                   |
| Relevant content      | Exact or explicitly bounded affected action set and changed consequence |
| Relevant restoration  | Expected reverse action set and original output identity                |
| Irrelevant content    | Zero production actions and stable output identity                      |
| Configuration         | Only consumers of that configuration invalidate                         |
| Provenance            | Only provenance-bearing leaves invalidate                               |
| Error-producing input | Expected action identity fails with the expected diagnostic category    |
| Missing graph edge    | Sensitivity control reports RED                                         |
| Restored graph edge   | Sensitivity control reports GREEN                                       |

The changed consequence is a digest, runtime behavior, structured diagnostic,
or evidence field outside the action-count query. `what-ran` output by itself
does not establish causality.

Cleanup executes for success, failure, interruption, and timeout. Failure to
restore source bytes, relevant modes and mtimes, daemon isolation, temporary
worktrees, or the original output identity changes the proof to `no-verdict`.

## Benchmark Protocol

Benchmark records use `buck-benchmark-observation/v1`. Each observation names:

- exact Git revision and dirty state;
- work-contract ID and whether equivalent work has been established;
- target set and tool versions;
- platform, runner class, and non-sensitive host class;
- local and remote cache modes;
- isolation directory and daemon treatment;
- phase, repetition, and warmup status;
- control results;
- wall duration and available action/materialization measurements;
- observation completeness; and
- output digest or safe output hash.

### Comparability key

Two samples are comparable only when these dimensions match:

```text
work contract
+ revision relation being tested
+ target set
+ tool versions
+ platform and runner class
+ cache mode and provenance
+ isolation and daemon treatment
+ phase definition
+ observation schema
```

Cross-engine comparison additionally requires an independently reviewed work
equivalence assertion. A shared label or successful exit does not establish
equivalent work.

Cold, daemon-restart, and remote-cache samples require successful controls:

| Phase                    | Mandatory control                                                |
| ------------------------ | ---------------------------------------------------------------- |
| Action-cold              | New isolation or successful action-cache clean                   |
| Daemon restart           | Successful daemon termination and new invocation identity        |
| Remote producer          | Trusted namespace, successful write, recorded artifact identity  |
| Remote consumer          | Fresh read-only consumer, expected hits, zero forbidden fallback |
| Relevant/irrelevant edit | Exact mutation and successful restoration                        |

A failed control emits a retained no-verdict observation. Summaries report
included sample count, excluded count by reason, median and dispersion, and
absolute and relative change. They never substitute zero for an unavailable
measurement or silently discard an outlier. Raw observations remain the
reviewable authority for the summary.

## Generated Graph Audit

The graph audit is intentionally cheaper than executing a graph compiler. It
compares base and head audit indexes derived from the authoritative semantic
graph and projection metadata, then selects the work needed to establish
freshness and behavior. The index is not another semantic graph.

### Graph record

`buck-generated-graph-index/v1` has this logical shape:

```json
{
  "schema": "buck-generated-graph-index/v1",
  "semanticGraphDigest": "sha256:...",
  "generator": {
    "contract": "effect-utils/genie/buck2/v1",
    "semanticFingerprint": "sha256:..."
  },
  "projections": [
    {
      "id": "otel-scrape",
      "owner": "packages/@overeng/otel-scrape/BUCK.genie.ts",
      "outputs": [{ "path": "packages/@overeng/otel-scrape/BUCK", "digest": "sha256:..." }],
      "targets": ["//packages/@overeng/otel-scrape:otel-scrape"],
      "compilerGroup": "otel-scrape",
      "platforms": ["x86_64-linux"],
      "inputs": [
        { "role": "membership", "selector": "packages/@overeng/otel-scrape/src/**/*.rs" },
        { "role": "closure", "selector": "packages/@overeng/otel-scrape/Cargo.lock" },
        { "role": "implementation", "selector": "buck2/tools/**/*" }
      ]
    }
  ]
}
```

Input roles have fixed meanings:

| Role                       | Meaning                                  | Selection                            |
| -------------------------- | ---------------------------------------- | ------------------------------------ |
| `producer`                 | Generator or graph-schema implementation | Affected graph compiler              |
| `membership`               | Path set or entry type                   | Owning graph compiler                |
| `analysis`                 | Source interpreted to derive a graph     | Owning analyzer/compiler             |
| `closure`                  | Dependency-resolution or toolchain input | Owning closure compiler              |
| `action-input`             | Content already declared to Buck         | Affected build/test shard only       |
| `implementation`           | Helper implementation internals          | Helper contract tests                |
| `implementation-interface` | Helper CLI, schema, or Buck label        | Contract tests and affected compiler |
| `generated-output`         | Checked-in projection                    | Exact digest and producer freshness  |

Source census records path membership separately from file contents. Editing
the contents of an already-declared action input does not require regeneration
unless that content is also an `analysis` or `closure` input.

### Audit algorithm

1. Decode both base and head graph indexes and reject unknown schema versions.
2. Verify that each index references its revision's authoritative semantic
   graph, then require unique projection IDs, owners, target labels, and output
   paths.
3. Validate normalized repo-relative paths and supported input roles.
4. Verify every recorded generated output exists and matches its digest.
5. Canonicalize and hash the base-to-head changed-path set.
6. Match every relevant changed, added, deleted, or renamed path against both
   base and head selectors so removed ownership cannot disappear from the
   decision.
7. Select compiler, contract, and execution shards from the matched roles.
8. If any relevant path is unknown or ambiguous, select the full safe set and
   record the fallback reason; if no full safe set exists, fail closed.
9. Emit the CI decision report before executing selected shards.

The audit does not claim that a generated output is semantically fresh when a
producer input changed. It only proves that the output matches its recorded
digest and identifies the compiler that must reproduce it.

### Runtime-neutral implementation identity

Graph semantics and helper implementation are separate records:

```json
{
  "semanticContract": {
    "id": "package-evidence/v1",
    "argvSchema": "package-evidence-argv/v1",
    "outputSchema": "buck-build-artifact/v1",
    "normalization": "ustar-canonical/v1"
  },
  "producerImplementation": {
    "runtime": "rust",
    "toolVersion": "...",
    "artifactDigest": "sha256:...",
    "platform": "x86_64-linux"
  }
}
```

Only semantic-contract changes require graph projection review. The concrete
implementation executable remains a declared execution dependency, so changing
it invalidates dependent actions and is visible in receipts. A runtime swap is
admitted through golden-byte, filesystem-mode, exit-status, error-category,
adversarial-input, and ambient-runtime-absence controls.

## CI Decision Report

Every planner invocation emits `buck-ci-decision/v1` before target execution:

```json
{
  "schema": "buck-ci-decision/v1",
  "baseRevision": "...",
  "headRevision": "...",
  "changedPathsDigest": "sha256:...",
  "graphRecordDigest": "sha256:...",
  "decisions": [
    {
      "shard": "otel-scrape",
      "selected": true,
      "reasons": ["closure"],
      "compilers": ["otel-scrape"],
      "checks": ["freshness", "build", "test"]
    },
    {
      "shard": "megarepo",
      "selected": false,
      "reasons": ["no-matching-input"],
      "compilers": [],
      "checks": []
    }
  ],
  "fallback": null,
  "result": {
    "verdict": "pass",
    "observation": "complete",
    "reasons": []
  },
  "evidence": []
}
```

The report is updated after execution with evidence-envelope references and the
final verdict. Ordering is canonical so the same inputs produce identical
bytes.

### Minimal execution policy

```text
every relevant change
  -> graph audit
  -> contract/sensitivity fixtures
  -> affected freshness and target shards
  -> one stable semantic aggregate

broader admission proof
  -> full clean regeneration
  -> full invalidation and platform matrix
  -> repeated comparable benchmarks
  -> cache producer/consumer controls when remote cache is in scope
```

An unselected shard is successful only as a planning fact: its report names
`no-matching-input`. It is not evidence that the shard's build or tests passed.
Stable required-check names describe topology, freshness, contract, and build
guarantees; they do not expose helper runtimes or individual target jobs as
branch-protection API.

## Retention and Publication

| Record                          | Public artifact       | Failure upload           | Retention constraint                      |
| ------------------------------- | --------------------- | ------------------------ | ----------------------------------------- |
| Sanitized receipt               | Yes                   | Yes, when produced       | Covers admission review window            |
| Evidence envelope               | Yes                   | Yes                      | Covers admission review window            |
| Graph record                    | Yes, tracked          | Not applicable           | Versioned with source                     |
| CI decision report              | Yes                   | Yes                      | Covers admission review window            |
| Benchmark raw observations      | Yes when sanitized    | Yes                      | Covers baseline window                    |
| Benchmark summary               | Yes                   | Yes                      | Must reference raw observations           |
| Raw event log/build report      | Restricted by default | Only after safe handling | Shortest useful diagnostic window         |
| Unrestricted stderr/environment | No                    | No                       | Local/restricted diagnostic handling only |

Artifacts are content-addressed where practical and include their schema
version. Upload steps run under success-or-failure policy and tolerate absence
only when the enclosing evidence record explains why the artifact could not be
produced. Publication must never turn an incomplete observation into a passing
receipt.

## Design Questions

- **DQ1 Raw native retention:** What redaction and access boundary permits
  retaining event logs and build reports for public-repository CI failures?
- **DQ2 Selector implementation:** Which matcher provides Git pathspec-compatible
  semantics without requiring the full Genie runtime?
- **DQ3 Baseline policy:** Which admission owner and evidence window define
  performance thresholds for each runner class?
