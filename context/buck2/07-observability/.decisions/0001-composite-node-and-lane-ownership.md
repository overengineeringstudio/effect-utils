# 0001 Composite Node and Lane Ownership

Status: accepted

Accepted 2026-09-25 (decisions q7, q16, q22, q15; Johannes).

## Context

The event-log telemetry lane spans five concerns: caller correlation, a
portable delivery unit, the decoder, trace shaping, and backend
delivery/retention. Existing boundaries pointed elsewhere: otel-scrape
decision 0012 admits per-tool adapters behind a vertical-slice gate, and
decision 0021 assigns the OTEL stack, collector policy, and fleet ingestion to
the dotfiles observability VRS. The buck2 tree carries the invariant (BUCK-R13)
and decision 0011's "versioned adapters" but no subsystem. A separate
build-telemetry root was considered and rejected: the Buck event log is the
dominant data source and a second root would have to be kept consistent with
buck2's protected documents.

## Evidence and Argument

- The lane's evidence is overwhelmingly Buck-shaped: the 22-log corpus, the
  decode bakeoffs, capture-mode and overhead measurements, span shaping, and
  the daemon-wait join are all about the event log (03 experiments).
- A domain reference map surveying six federated vocabularies (buck2,
  otel-scrape, caller plumbing, dotfiles observability, OTel semconv, Buck2
  upstream, plus Bazel/BuildBuddy prior art) found no existing node that owns
  this lane's vocabulary end to end; the ontology decision
  ([0002](./0002-observability-vocabulary.md)) records the borrows.
- otel-scrape's exporter is private and wrapper-specific; its adapter contract
  parses tool _output_, not a versioned wire format. Forcing this lane through
  the 0012 gate would demand a structured-source tier the gate never
  anticipated.
- Delivery needed one decision shape, not three owners: the CI-agnostic
  bakeoff (q18) scored provider-neutral bundle upload strictly better on
  local/CI parity and coupling.

## Options

| Option                                                             | Tradeoff                                                                                              | Outcome                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Composite node `buck2/07-observability` with children by data flow | One readable tree; reuses the buck2 vision; consciously overrides the otel-scrape split for this lane | Accepted (q16, q22)                                                   |
| New root `context/build-telemetry/`                                | Vision-level anchor for a cross-cutting goal                                                          | Rejected: second root to keep consistent; Buck is the dominant source |
| Split by owner (otel-scrape + buck2 + dotfiles)                    | Respects the 0012/0021 seams                                                                          | Rejected by q7: three owners for one lane                             |
| Flat subsystem (no children)                                       | Simplest                                                                                              | Rejected (q22): five distinct bakeoff domains in one spec             |

## Decision

`context/buck2/07-observability/` is a composite node: no vision of its own
(the buck2 vision applies), role stated atop its requirements, IDs
`BUCK.OBS-R*` with path-prefixed child IDs and `refines:` links. It has five
children in data-flow order: `01-run-identity`, `02-run-record`,
`03-event-log-adapter`, `04-trace-views`, `05-ingest-and-archive`.

The lane — adapter, wiring, CI path, bakeoffs, benchmarks — is owned here,
consciously overriding the otel-scrape adapter admission gate (0012) and the
observability boundary (0021) for the Buck event-log lane; both decisions
carry cross-references. The dotfiles fleet config remains the implementer of
the deployed stack (ingester, auth, store, retention) against the contract
this tree specifies. The "CI is unspecial" principle (q15) becomes a
requirement here (BUCK.OBS-R03), applied fully to this lane now, with a
read-only CI-coupling audit as a separate epic.

## Consequences

- One tree owns the lane end to end; otel-scrape keeps the wrapped-tool
  adapter contract untouched.
- Non-Buck concerns (devenv task spans, CI delivery, retention) live under
  buck2 with explicit seams (spec, Cross-Tree Relationships).
- Decision 0011 is amended for this lane: the versioned adapter is a
  direct-decode Rust crate; the caller-side `otel-span` buck2 mode prepares
  environment and span without interposition.
