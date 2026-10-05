# Buck2 Observability Spec

This document specifies the observability lane's architecture and its children's
boundaries. It builds on [requirements.md](./requirements.md); each child spec
owns its mechanism. Vocabulary is defined in [ontology.md](./ontology.md).

## Status

Draft.

## Scope

**Defines:** pipeline/job trace identity, local evidence conversion, OTLP
delivery, and job-level PR reporting; the child specs own each mechanism.

**Does not define:** collector/backend deployment (consumer-owned), workflow
generation (genie ci-workflow), or the build-speed work measured by this lane.

## Data Flow

```text
devenv tasks run [01] -> Buck command + native event log [03]
         │                         │
         └── task spans ───────────┴── local telemetry spool [02]
                                           │ convert -> trace views [04]
                                           │ one burst at job end [05]
                                           v
                                  configured collector -> consumer-selected backend
                                           │
attempt close [01] -> small pipeline trace linking started job IDs
GitHub Workflow Runs API -> successful main run IDs ───┐
GitHub Jobs API -> current/main job timings ───────────┴─> PR table,
                             gantt, p50(main × 7) [06], Grafana trace links
```

The same conversion and export path runs on a laptop and in CI. A consumer-admitted
same-repo PR job or main push exports when `CI_EVIDENCE_MODE=upload`; a local run
exports only with consumer admission and access to the configured collector.
Fork jobs leave the local spool unexported. Export waits until build work ends,
then establishes any required collector connectivity immediately before delivery
(#1477). The consumer owns network/access policy; no evidence upload service,
archive, index, or reconciliation worker is required.
A failed decode or export never changes the Buck result (BUILD.BUCK.OBS-R01–R04).

### CI action-cache evidence

```text
Buck native event log -> `buck2 log show` -> bounded JSON projection -> job artifact
```

Buck-capable public CI jobs retain `buck2-cache-evidence-<job>[-<matrix-index>]-<attempt>`
artifacts for 14 days, independently of OTLP delivery. Schema version 1 includes
repository, run, attempt, job, head revision and public-cache posture metadata;
per-invocation build IDs and complete outcome counts; and at most 64 representative
action rows across the invocations. Each row carries native category, target,
configuration, exact RE ActionCache digest (`hash:size`), and cache outcome.
Commands, environments, stdout/stderr and runner filesystem paths are not retained.

The projector uses numeric native execution/upload enums: action-cache execution is
`remote-hit`; a successful cache upload is `uploaded`; local execution, local cache,
remote execution and remote dep-file hits remain distinct. Omitted rows and missing
command digests are counted explicitly. Duplicate logs of one native build ID do not
double-count actions. The trusted populate/replay proof captures each context before
its native logs are removed, retaining uploads and hits in the same job artifact.

`no-native-logs` means no native Buck invocation was observed, not a cache hit.
In-Nix product jobs report `remote-cache-disabled-by-design` with no action rows:
their reuse measure is Nix output substitution, not shared Buck AC. Failed evidence
collection is visible in job logs and does not change the product result.

## Children

| Child                                                  | Owns                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| [01-run-identity](./01-run-identity/spec.md)           | pipeline and job identity, caller↔Buck correlation, links |
| [02-local-spool](./02-local-spool/spec.md)             | local retryable evidence and span spool                   |
| [03-event-log-adapter](./03-event-log-adapter/spec.md) | versioned event-log decode and daemon wait                |
| [04-trace-views](./04-trace-views/spec.md)             | full/critical view selection, cap, bounded metrics        |
| [05-otlp-delivery](./05-otlp-delivery/spec.md)         | job-end OTLP burst, collector access, retry and retention |
| [06-trace-access](./06-trace-access/spec.md)           | Jobs API PR report and deterministic Grafana links        |

`02` retains local inputs from `01`; `03` decodes Buck evidence, `04` shapes
the traces, and `05` delivers them. `06` uses the workflow-runs API to
enumerate baseline runs, the Jobs API for timings, and IDs derived from `01`
for links, without reading Tempo from CI.

## Cross-Tree Relationships

- **otel-scrape:** this lane owns direct event-log decoding under
  [decision 0001](.decisions/0001-composite-node-and-lane-ownership.md);
  otel-scrape keeps the wrapped-tool adapter contract.
- **Consumer profile:** endpoint selection, export admission, collector/backend
  deployment, routing and retention belong to the consumer. This tree specifies
  the portable producer contract ([05](./05-otlp-delivery/spec.md)).
- **Sibling buck2 subsystems:** serial `tsgo_emit`, slot contention, editor
  bootstrap, cache latency and daemon wait belong to their respective
  subsystem owners; this lane measures them.
- **buck2 decision 0011:** the caller-side `otel-span` buck2 mode prepares
  environment and span identity; the caller invokes Buck directly and
  completes its command span post hoc, with no interposition
  ([Amendment 1](../../.decisions/0011-direct-native-evidence-observation.md)).

## Open Design Questions

Unresolved backend volume (OQ1), upstream daemon-wait attribution (OQ2), and
OTel CICD naming migration (OQ4) live in [open-questions.md](./open-questions.md).
Task-level PR reporting requires an isolated build-telemetry read scope and an
authenticated, restricted read proxy
([roadmap.md](./roadmap.md)); CI does not receive unrestricted consumer-backend read authority.
