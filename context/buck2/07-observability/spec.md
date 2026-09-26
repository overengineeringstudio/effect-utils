# Buck2 Observability Spec

This document specifies the observability lane's architecture and its children's
boundaries. It builds on [requirements.md](./requirements.md); each child spec
owns its mechanism. Vocabulary is defined in [ontology.md](./ontology.md).

## Status

Draft.

## Scope

**Defines:** the path from pipeline identity through indexed evidence to
trace access, child ownership boundaries, and the cross-tree relationships
(otel-scrape, dotfiles fleet config, sibling buck2 subsystems).

**Does not define:** fleet deployment of the evidence service (dotfiles), CI
workflow generation (genie ci-workflow), or speedup work measured by this lane.

## Data Flow

```text
devenv tasks run entrypoint [01] ── PIPELINE_RUN_ID, seeded trace context
  └─ caller prepares Buck command span / wrapper UUID, invokes Buck directly
       └─ native evidence + span spool ──> per-job/local run record [02]
                                           seal: content digests, VCS identity
                                           upload: tailnet capability or spool-only
              CI finalizer ── attempt-close roster [02] ──┐
                                             │             │
                                             v             v
                          buck2-evidence [05]: atomic enqueue + worker
                             ├─ event-log adapter [03]: decode + daemon waits
                             ├─ trace views [04]: critical in caller trace;
                             │                     linked full trace
                             ├─ close roster / 6 h timeout -> one CI root
                             ├─ cumulative by-ID readback across jobs
                             └─ chunked OTLP → Tempo (30 d), metrics → Mimir
                                   raw archive + index (~1 y)
                                             │ read only
                                             v
                          trace access [06]: PR resolver /t/<id>, JSON,
                          overview + baseline, Grafana / Perfetto;
                          copyable CLI freeze -> caller's Vista context
```

Every stage is offline-safe: a failure anywhere right of the Buck command
leaves the build result and the native evidence untouched (BUCK.OBS-R01).

## Children

| Child | Owns |
| --- | --- |
| [01-run-identity](./01-run-identity/spec.md) | pipeline-run trace seed, entrypoint and caller↔Buck command correlation |
| [02-run-record](./02-run-record/spec.md) | per-job/local records, VCS fields, seal/upload and CI attempt-close roster |
| [03-event-log-adapter](./03-event-log-adapter/spec.md) | direct decode, vendored schema, span model and daemon wait |
| [04-trace-views](./04-trace-views/spec.md) | full/critical view rules, cap, summaries and bounded metrics |
| [05-ingest-and-archive](./05-ingest-and-archive/spec.md) | single service, queued ingest, attempt completion, cumulative Tempo readback and retention |
| [06-trace-access](./06-trace-access/spec.md) | read-only PR/trace resolver, review page, JSON and caller-owned Vista freeze command |

Dependency order follows data flow: `02` consumes identity from `01`, `03`
decodes the native evidence in `02`, `04` shapes spans from `03`, `05`
indexes and exports those views, and `06` reads the `05` index. Deployment
can co-locate ingest and access in one binary without mixing ownership.

## Cross-Tree Relationships

- **otel-scrape:** the lane is owned here by decision
  ([0001](./.decisions/0001-composite-node-and-lane-ownership.md)), consciously
  overriding the otel-scrape adapter admission gate (their 0012) and boundary
  (their 0021) for the Buck event-log lane; otel-scrape keeps the wrapped-tool
  adapter contract. Both decisions carry cross-references.
- **dotfiles fleet config:** Tempo (30 d), Mimir, the hardened evidence unit,
  separate Tailscale Services for upload and read-only resolution, ZFS
  placement, and retention are deployed there. This tree specifies the
  contract ([05](./05-ingest-and-archive/spec.md),
  [06](./06-trace-access/spec.md)).
- **Sibling buck2 subsystems:** measured bottlenecks found through this lane
  (serial `tsgo_emit` chain, 8-slot contention, uncached editor bootstrap,
  cache-service latency, daemon wait on shared daemons) are recorded as
  findings in the owning subsystems' open questions; this lane owns only their
  measurement.
- **buck2 decision 0011:** amended — the versioned adapter is a direct-decode
  Rust crate, and the caller-side `otel-span` buck2 mode only prepares
  environment and span identity; the caller invokes Buck directly and
  completes the command span post hoc — no supervision, no interposition
  ([Amendment 1](../.decisions/0011-direct-native-evidence-observation.md)).

## Open Design Questions

Open questions and their resolution signals live in
[open-questions.md](./open-questions.md): Tempo volume under both-views ingest
(OQ1), upstream daemon-wait attribution acceptance (OQ2), optional direct-OTLP
fast-path prerequisites (OQ3), `ci.*` vendor-key migration (OQ4), and the
CI-coupling audit (OQ6). Evidence-namespace deployment details in OQ5 are
settled by the dedicated dotfiles build-evidence fleet trait; fork upload
remains deferred.
