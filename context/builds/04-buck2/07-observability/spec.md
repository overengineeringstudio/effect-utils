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
