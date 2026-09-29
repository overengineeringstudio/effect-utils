# Buck2 Observability Ontology

This ontology inherits the buck2 root terms (Semantic Operation, Action,
Native Evidence, Materialization) and adds the observability lane's vocabulary.
It was settled against a domain reference map of six federated sources
(decisions q19–q21, 2026-09-25).

## Language

### Run hierarchy (OTel CICD, used for local and CI runs alike)

**Pipeline Run** is one local entrypoint invocation or one CI pipeline attempt
across all its jobs. It maps to OTel `cicd.pipeline.run.*`. _Avoid_: "CI run"
for local runs; both use the same vocabulary (BUCK.OBS-R03).

**Pipeline Run ID** is the provider-neutral identity of that invocation or
attempt, minted only if absent and propagated across jobs. It is not a trace
ID: the pipeline trace ID derives deterministically from it. _Avoid_:
"provider run ID" for this cross-provider identity.

**Job Run** is one matrix-qualified CI job execution inside a Pipeline Run;
its job key includes matrix values so sibling variants cannot collide.

**Task Run** is one devenv task execution inside a Pipeline Run or Job Run.
It maps to `cicd.pipeline.task.*`; the existing `devenv.task.exec` span
represents this concept (the naming migration is OQ4).

**Worker** is where a pipeline run executed (a laptop or a CI runner):
`cicd.worker.*`. The provider (e.g. GitHub Actions) is a resource
attribute (`ci.provider`) in telemetry; the separate PR reporter calls its
provider's Jobs API.

### Buck layer (upstream words, kept as-is)

**Buck Command** is one CLI subcommand run against the daemon — the event
log's unit. Span name `buck2.command <subcommand>`.

**Action** and **Executor Stage** keep the buck2 root meanings; stages are the
per-action subphase spans (queue, execute, cache query, input materialization).

**Event Log** is the per-command `*_events.pb.zst` artifact: zstd-compressed
length-delimited protobuf, one `Invocation` header then `CommandProgress`
records. Execution truth.

**Build Report** is the at-build-time per-target output record.

**InvocationRecord** is the upstream end-of-command aggregate artifact
(`--unstable-write-invocation-record`), explicitly unstable. The word
"invocation" is banned everywhere else.

**Critical Path** and **Slowest Path** are the upstream pair (theoretical
lower bound vs. actual elapsed-time path); always named together when both
matter.

**Final Materialization** is the upstream output-materialization span kind —
always qualified against the root ontology's Materialization (dependency
surface).

**Buck Trace Id** is the upstream per-command trace UUID
(`BUCK_WRAPPER_UUID` / `--write-build-id`). _Avoid_: "build id" — it collides
with `app.build_id` and binary build ids.

**Wrapper Trace Id** is the caller-derived form
`uuidform(sha256(trace_id:command_span_id))` exported as `BUCK_WRAPPER_UUID`.

**Command Span** is the caller-owned span for one Buck command (the
`otel-span` buck2 mode opens it). The otel-scrape "command span" (wrapped
process) is a different, scoped sense — see flagged ambiguities.

**Task Span** is the existing `devenv.task.exec` span (a Task Run's span).

**Job Trace** is the trace for one matrix-qualified CI Job Run (or one local
Task Run), exported in one burst at job end. Its root identifies the Pipeline
Run with `cicd.pipeline.run.id`.

**Pipeline Trace** is the small trace written at attempt close; its root links
to the Job Traces rather than parenting their spans. Distinct attempts remain
distinct.

**Trace Access** is the PR job report and deterministic Grafana trace links.
The report reads GitHub Actions job timings; Grafana reads traces from Tempo.
_Avoid_: "resolver" for a link whose ID is derived without a lookup.

### The local retry unit

**Local Spool** holds caller spans and native Buck evidence until the job-end
OTLP export completes or can be retried. It is not a durable archive: after
spool removal, derived traces cannot be regenerated. _Avoid_: "run record",
"archive", or "upload bundle" for this local retry state.

**Span Spool** is the existing otel-span JSONL spool
(`OTEL_SPAN_SPOOL_DIR`), retained within the Local Spool for export retry.

**OTLP Delivery** sends derived traces to the dev3 collector over a tailnet
ACL grant. Fork jobs keep a Local Spool but do not export.

### Derived artifacts

**Event-Log Adapter** is the versioned adapter (decision 0011's word) that
decodes event logs directly into the span model — a dedicated Rust crate,
qualified against otel-scrape's per-tool Adapter contract.

**Trace View** is a deterministic, rule-selected subset of a Buck command's
spans derived from native evidence while it remains locally available.
**Full View** keeps every span; **Critical View** (the default) keeps the
critical path, spans at or above the **View Threshold**, their ancestors, and
command summaries, under the **View Cap**. _Avoid_: "slim", "shaping",
"projection" (two other senses in the fleet).

**Daemon Wait** is time a Buck command spends blocked on work another command
in the same daemon owns. **Inferred Daemon Wait** is a join-derived span
marked with a confidence tier and producer links; a `DiceBlockConcurrentCommand`
event read directly is exact attribution.

**Bounded Metrics** are the five closed-enum Mimir metrics
(`buck2.command.duration`, `buck2.critical_path.duration`,
`buck2.action.count`, `buck2.action.execution.duration`,
`buck2.action.queue.duration`); their label sets never include unbounded
identifiers.

## Structure

```text
partOf ladder:   pipeline run -> job run (CI) -> task run -> Buck command -> action -> executor stage
                 (local task runs may belong directly to the pipeline run)
delivery:        native evidence + task spans -> local spool -> adapter -> trace views -> job-end OTLP
derivation:      event-log adapter -> span model -> {full view, critical view} + bounded metrics
identity:        pipeline run id -> per-job trace id + attempt-close pipeline trace id;
                 wrapper trace id = f(caller trace id, command span id);
                 salted OTLP span ids = f(log identity, Buck span id) (Buck ids collide across commands)
access:          Jobs API -> job table + gantt + p50 delta; deterministic trace id -> Grafana
wait:            peer commands on one daemon -> daemon wait (exact | inferred)
```

## Flagged Ambiguities

- **Local Spool vs Pipeline Run vs InvocationRecord:** CI jobs carry local
  spools and emit one trace each; attempt close links those traces. A local
  invocation has one spool. InvocationRecord is an upstream per-command
  artifact, not a portable delivery unit.
- **Trace view vs editor view:** "view" also names the materialization
  surface's editor views (03-materialization). "Trace view" is always
  qualified.
- **Command (five fleet senses):** here only the Buck sense and the caller's
  command span; a wrapped process is otel-scrape's scoped "command span"; a CI
  step is a Task Run.
- **Evidence:** Native Evidence (execution truth) vs. evidence at transfer
  (BUCK-R12 proof) vs. probe evidence artifacts (context/ci). The spool holds
  Native Evidence only until local retry succeeds or the spool expires.
- **Materialization:** the root triple homograph plus upstream final/input
  materialization — always qualified.
- **Trust:** otel-scrape trusted sink (privacy) and cache trust tiers (0033)
  are separate from this lane's tailnet collector write ACL.
- **Adapter:** otel-scrape Adapter (per-tool structured output) vs. this
  lane's event-log adapter (0011's versioned adapter) vs. ci measurement
  producer adapters. The qualified forms are load-bearing.
