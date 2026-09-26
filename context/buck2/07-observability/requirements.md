# Buck2 Observability Requirements

This subsystem owns build telemetry for the Buck2 lane: identity correlating
pipeline runs and Buck commands, the portable run record, event-log decoding,
derived trace views and bounded metrics, ingest/archive, and index-backed
trace access for reviewers and agents. It is a composite node with children
[01-run-identity](./01-run-identity/requirements.md),
[02-run-record](./02-run-record/requirements.md),
[03-event-log-adapter](./03-event-log-adapter/requirements.md),
[04-trace-views](./04-trace-views/requirements.md),
[05-ingest-and-archive](./05-ingest-and-archive/requirements.md), and
[06-trace-access](./06-trace-access/requirements.md).
It refines BUCK-R13 (and BUCK-R12 advisory, BUCK-R14 hygiene) from the
[buck2 requirements](../requirements.md); the buck2 vision applies unchanged.

## Context

- Builds on [BUCK-R13](../requirements.md): native evidence stays execution
  truth; telemetry links to it without replacing it.
- [Decision 0011](../.decisions/0011-direct-native-evidence-observation.md):
  the caller owns the command span; versioned adapters decode native
  evidence; no component interposes on Buck.
- This lane is owned here, not in `context/otel-scrape`, by decision
  ([0001](./.decisions/0001-composite-node-and-lane-ownership.md)); the
  otel-scrape adapter admission gate (0012) and boundary (0021) carry a
  cross-reference.

## Assumptions

- **BUCK.OBS-A01 Native evidence authority:** Buck's event log, build report,
  and command identity are the only execution truth
  (BUCK-A01, BUCK-R13).
- **BUCK.OBS-A02 Semconv availability:** OTel CICD (`cicd.pipeline.*`,
  `cicd.worker.*`), `vcs.*`, and `process.*` attributes are usable at Release
  Candidate quality; the fleet observability conventions govern naming and
  cardinality.
- **BUCK.OBS-A03 Fleet stack:** Tempo, Mimir, and the collector are deployed
  and owned by the dotfiles fleet config; this subsystem specifies contracts,
  not deployment
  ([decision 0001](./.decisions/0001-composite-node-and-lane-ownership.md)).
- **BUCK.OBS-A04 Run volume:** roughly 90 pipeline runs per day across the
  fleet's repositories is the planning volume for retention sizing.

## Acceptable Tradeoffs

- **BUCK.OBS-T01 Version-bound adapter:** the event-log adapter pins a vendored
  protobuf schema to the newest fleet producer and re-pins on every Buck bump
  (inherits BUCK-T02; mechanism:
  [03-event-log-adapter](./03-event-log-adapter/requirements.md)).
- **BUCK.OBS-T02 Both views until measured:** ingesting the full trace view
  alongside the critical view everywhere is accepted before Tempo volume is
  measured, with an explicit dial-in trigger
  ([open question OQ1](./open-questions.md); decision q24, 2026-09-25).

## Requirements

### Must keep telemetry subordinate to native evidence

- **BUCK.OBS-R01 Derived, never authoritative (refines BUCK-R13):** Every
  telemetry artifact this subsystem derives from a run record's native
  evidence — trace views, daemon-wait spans, bounded metrics — is derived,
  never authoritative, and can be regenerated from the archived run record.
  The run record itself is the source of record for those derivations, not
  something Buck's evidence can regenerate (it also carries the caller's
  span spool and run metadata). Export, ingest, or decode failure never
  changes a Buck result and never blocks a build.
- **BUCK.OBS-R02 Unknown fields are data loss, not errors:** Fields the pinned
  schema does not know are skipped and counted per log; a decode never fails
  because of unknown content. Only framing damage or schema-type conflicts fall
  back (and then loudly; untrusted records never fall back — see 03).

### Must be identical locally and in CI

- **BUCK.OBS-R03 CI is unspecial:** The same commands, the same code path, and
  the same telemetry delivery run locally and in CI. CI supplies only
  environment and configuration; no CI-provider-specific telemetry mechanism
  exists in the delivery path, and coupling to any one CI provider is minimal
  so the setup can be lifted and shifted. The provider appears only as data
  (resource attributes), never as control flow
  (decision q15, 2026-09-25; audit follow-up tracked in
  [open-questions.md](./open-questions.md)).
- **BUCK.OBS-R04 Run record is the system of record:** Delivery means sealing
  and uploading a run record; direct OTLP export is an optional fast path, not
  the durable path. No CI-provider artifact API is a delivery dependency.

### Must bound volume and cardinality

- **BUCK.OBS-R05 Bounded metric labels (refines BUCK-R13):** Metric labels
  are closed enums or bounded values — never target labels, identifiers,
  digests, run ids, trace ids, or hostnames. Trace and resource attributes
  are permitted a fixed set of high-cardinality identifiers for per-run
  discovery: `cicd.pipeline.run.id`, `cicd.pipeline.run.attempt`,
  `cicd.pipeline.task.run.id`, `vcs.ref.head.revision`,
  `vcs.repository.url.full`, `vcs.change.id`, `ci.provider`, `ci.pr.fork`,
  and the Buck trace id. None of these ever becomes a metric label.
- **BUCK.OBS-R06 Retention corridor:** Trace storage holds 30 days; long-term
  trends come from bounded metrics; raw native evidence is archived for
  about one year at a bounded budget (**≤150 GiB/yr** at the planning
  volume, superseding q14's earlier figure per q32, 2026-09-25; measured
  projection ~125 GiB/yr; re-measured under
  [OQ1](./open-questions.md)). Widening beyond the corridor requires a
  measured volume decision.

### Must own identity exactly

- **BUCK.OBS-R07 Fail-open caller correlation:** Caller-side correlation
  degrades to "unset" — never to a malformed value. Buck must never receive an
  invalid `BUCK_WRAPPER_UUID` (a malformed or empty value fails the build at
  client start; measured, rc=2).

### Must stay portable

- **BUCK.OBS-R08 Portability hygiene (refines BUCK-R14):** Schemas, manifests,
  and fixtures carry no hostnames, host paths, usernames, or fleet endpoints.
  Provider-specific facts appear only as provider-neutral attributes
  (`cicd.*`, `vcs.*` where the conventions exist).

### Must dissolve superseded paths

- **BUCK.OBS-R09 Named deletions (refines BUCK-R09):** Each landed mechanism
  names the producer it supersedes — the CI span artifact upload step, the
  scratch converter, any compatibility artifact re-ingest path — and the
  transfer change deletes it.

## Requirement Trace

| Requirements                             | Refinement                     |
| ---------------------------------------- | ------------------------------ |
| BUCK.OBS-R01, BUCK.OBS-R02               | 03 Event-log Adapter           |
| BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R07 | 01 Run Identity, 02 Run Record |
| BUCK.OBS-R05, BUCK.OBS-T02               | 04 Trace Views                 |
| BUCK.OBS-R03, BUCK.OBS-R06, BUCK.OBS-R08 | 05 Ingest and Archive          |
| BUCK.OBS-R01, BUCK.OBS-R03, BUCK.OBS-R04, BUCK.OBS-R08 | 06 Trace Access |
| BUCK.OBS-R09                             | Root + all children            |
