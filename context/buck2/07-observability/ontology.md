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
`cicd.worker.*`. The provider (e.g. GitHub Actions) appears only as a resource
attribute (`ci.provider`), never in control flow or schema shape.

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

**Pipeline Trace** is the per-attempt trace that joins a Pipeline Run, its
jobs and task runs with Buck Critical Views. Distinct attempts are related
by links, not parent-child identity.

**Trace Access** is the read-only discovery surface over indexed run records
and derived traces. Its **Resolver** maps a PR, run, or deterministic trace ID
to an indexed status and viewer link; it does not search Tempo to discover
identity. _Avoid_: "trace store" for the resolver — Tempo stores the spans.

### The portable unit

**Run Record** is a sealed unit of telemetry and native evidence. In CI each
job contributes its own record within one Pipeline Run; locally the invocation
has one record. Each record contains a manifest, span spool, and native
evidence. Its lifecycle verbs are **seal** (freeze content digests),
**upload** (provider-neutral content-addressed PUT), **ingest** (convert,
export views, archive), and **archive** (retain per policy). _Avoid_:
"replay" — Buck owns `log replay` (Superconsole re-rendering);
"evidence bundle" (the anchor is Run Record).

**Attempt-Close Record** is the provider-neutral CI completion signal for a
Pipeline Run attempt: the expected matrix-qualified jobs and their conclusions.
It is not another job's native evidence or a second run root.

**Span Spool** is the existing otel-span JSONL spool
(`OTEL_SPAN_SPOOL_DIR`), reused unchanged as the run record's span part.

**Trust Signal** is the explicit, provider-level authorization that lets an
untrusted run's record be uploaded (on GitHub: a PR label). One of three
gates named "trust" — see flagged ambiguities.

### Derived artifacts

**Event-Log Adapter** is the versioned adapter (decision 0011's word) that
decodes event logs directly into the span model — a dedicated Rust crate,
qualified against otel-scrape's per-tool Adapter contract.

**Trace View** is a deterministic, rule-selected subset of a Buck command's
spans derived from the run record. **Full View** keeps every span; **Critical
View** (the default) keeps the critical path, spans at or above the **View
Threshold**, their ancestors, and command summaries, under the **View Cap**.
_Avoid_: "slim", "shaping", "projection" (two other senses in the fleet).

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
unit lifecycle:  run record: write -> seal -> upload -> ingest -> archive
derivation:      run record --event-log adapter--> span model --trace views--> {full view, critical view} + bounded metrics
identity:        pipeline run id --framed domain-separated hash--> pipeline trace id;
                 wrapper trace id = f(caller trace id, command span id);
                 salted OTLP span ids = f(log identity, Buck span id)  (Buck ids collide across commands)
access:          index --resolver--> PR/run/trace links and versioned JSON
wait:            peer commands on one daemon --join--> daemon wait (exact | inferred)
```

## Flagged Ambiguities

- **Run Record vs Pipeline Run vs InvocationRecord:** a CI Pipeline Run can
  contain many job-scoped Run Records plus one Attempt-Close Record; a local
  invocation has one Run Record. InvocationRecord is an upstream per-command
  artifact inside a record, never the portable unit.
- **Trace view vs editor view:** "view" also names the materialization
  surface's editor views (03-materialization). "Trace view" is always
  qualified.
- **Command (five fleet senses):** here only the Buck sense and the caller's
  command span; a wrapped process is otel-scrape's scoped "command span"; a CI
  step is a Task Run.
- **Evidence:** Native Evidence (execution truth) vs. evidence at transfer
  (BUCK-R12 proof) vs. probe evidence artifacts (context/ci). The run record
  _carries_ Native Evidence; it is not a proof calculus.
- **Materialization:** the root triple homograph plus upstream final/input
  materialization — always qualified.
- **Trust:** three gates — otel-scrape trusted sink (privacy), cache trust
  tiers (0033), and this lane's trust signal (ingest admission). Always
  qualified.
- **Adapter:** otel-scrape Adapter (per-tool structured output) vs. this
  lane's event-log adapter (0011's versioned adapter) vs. ci measurement
  producer adapters. The qualified forms are load-bearing.
