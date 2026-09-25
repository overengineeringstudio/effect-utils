# Buck2 Observability Spec

This document specifies the observability lane's architecture and its children's
boundaries. It builds on [requirements.md](./requirements.md); each child spec
owns its mechanism. Vocabulary is defined in [ontology.md](./ontology.md).

## Status

Draft.

## Scope

**Defines:** the data flow from caller identity to archived evidence, child
ownership boundaries, and the cross-tree relationships (otel-scrape, dotfiles
fleet config, sibling buck2 subsystems).

**Does not define:** deployment of the ingest stack (dotfiles), CI workflow
generation (genie ci-workflow), or the speedup work whose findings this lane
recorded for other owners.

## Data Flow

```text
caller (devenv task / CI job)
  |  otel-span buck2 mode PREPARES (then exits): pre-derived command span id,
  |  W3C validation, BUCK_WRAPPER_UUID = uuidform(sha256(trace_id:command_span_id)),
  |  sidecar line
  v
buck2 command (invoked directly by the caller, 0011) --native evidence--> *_events.pb.zst + build report
  |  caller emits the completed command span post hoc (emit-span, pre-derived id, fail-open)
  v
run record  = manifest + span spool + native evidence      [02-run-record]
  |  seal: freeze manifest with digests
  |  upload: one provider-neutral content-addressed PUT (or spool-only)
  v
ingest (identical locally and on the fleet dev host)       [05-ingest-and-archive]
  |  event-log adapter: direct zstd+protobuf decode, vendored pinned schema,
  |  span model, daemon-wait join                           [03-event-log-adapter]
  |  trace views: critical view (in the caller's trace) + full view
  |  (separate linked trace), bounded metrics               [04-trace-views]
  |  chunked OTLP (<~3.5 MB) --> Tempo (30 d); metrics --> Mimir
  v
archive: raw run records ~1 y, indexed, retention-timed     [05-ingest-and-archive]
query: Grafana / Vista / TraceQL against deterministic trace ids
```

Every stage is offline-safe: a failure anywhere right of the Buck command
leaves the build result and the native evidence untouched (BUCK.OBS-R01).

## Children

| Child                                                    | Owns                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [01-run-identity](./01-run-identity/spec.md)             | caller↔Buck correlation: command spans, `BUCK_WRAPPER_UUID` derivation, sidecar, salting |
| [02-run-record](./02-run-record/spec.md)                 | the portable unit: spool, manifest, native-evidence capture, seal, upload, trust signal  |
| [03-event-log-adapter](./03-event-log-adapter/spec.md)   | direct decode, vendored schema and bump policy, span model, daemon wait                  |
| [04-trace-views](./04-trace-views/spec.md)               | full/critical view rules, cap, command summaries, bounded metrics                        |
| [05-ingest-and-archive](./05-ingest-and-archive/spec.md) | local/dev-host ingest, Tempo/Mimir export, archive, retention, fork ingest               |

Dependency order is the data flow: `02` consumes what `01` minted, `03` decodes
what `02` carried, `04` shapes what `03` produced, `05` stores what `04`
selected. Nothing flows backward.

## Cross-Tree Relationships

- **otel-scrape:** the lane is owned here by decision
  ([0001](./.decisions/0001-composite-node-and-lane-ownership.md)), consciously
  overriding the otel-scrape adapter admission gate (their 0012) and boundary
  (their 0021) for the Buck event-log lane; otel-scrape keeps the wrapped-tool
  adapter contract. Both decisions carry cross-references.
- **dotfiles fleet config:** Tempo (30 d), Mimir, the ingester service, auth
  front, object-store ACL/lifecycle, index, and retention timer are deployed
  there. This tree specifies the contract they implement
  ([05](./05-ingest-and-archive/spec.md)).
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
(OQ1), upstream daemon-wait attribution acceptance (OQ2), direct-OTLP fast-path
prerequisites (OQ3), `ci.*` vendor-key migration (OQ4), evidence-namespace
lifecycle details (OQ5), and the CI-coupling audit (OQ6).
