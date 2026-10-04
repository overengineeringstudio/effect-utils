# Buck2 Observability Intuition

_For: repository maintainers and tooling authors · Assumes: the buck2 VRS
intuition, OTel traces basics · Covers: how build telemetry flows and why it
is shaped this way_

Buck already records everything worth knowing: every command writes an event
log with the full span tree, per-action stages, cache outcomes, and the
critical path. Nothing here watches Buck from outside. The lane's whole job is
to move that existing truth to where it can be queried — without changing what
a build means.

The mental model is a local conversion followed by one export burst:

```text
identity:  caller task -> command span -> wrapper trace id (BUCK_WRAPPER_UUID)
capture:   Buck event log + caller spans -> local retry spool
derive:    event-log adapter -> {full view, critical view} + bounded metrics
deliver:   job-end OTLP -> configured collector -> consumer-selected retention/backends
report:    Jobs API timings -> PR table + gantt + p50 delta -> Grafana trace links
```

Telemetry is derived, never authoritative. Native Buck evidence remains the
execution truth; views can be regenerated only while their local spool exists.
Tempo keeps 30 days of traces, with no raw archive behind it. A failed export
leaves the Buck result unchanged and retains the local spool for retry.

CI and a laptop use the same conversion and export path. CI joins the tailnet
after build work, immediately before sending to the collector. Same-repo PR
and main jobs export; forks only spool. Each job exports its own trace in one
burst so a mid-run Grafana read does not expose the shared-trace spaced-burst
loss; the attempt-close trace links those job traces. The PR comment gets its
durations from the Jobs API rather than giving a CI runner access to all fleet
traces.

Two identity facts drive the design. Buck span ids are per-command counters
that always include 0 — every pair of commands collides — so exported span ids
are salted deterministically per command. And Buck accepts any 32-hex
`BUCK_WRAPPER_UUID` but fails the whole build on a malformed one, so the
caller-side wrapper validates the W3C context first and degrades to _unset_,
never to garbage. Correlation is thus a pure function: the wrapper trace id
derives from the caller's trace and command span, and the sidecar line makes
the mapping durable.

The lane lives under buck2 because the event log is the dominant source, but
its seams are explicit: otel-scrape keeps the wrapped-tool adapter contract
(this lane consciously overrides its admission gate and boundary decision for
the event-log lane), and the dotfiles fleet config deploys the stack this tree
specifies. Measured bottlenecks the traces revealed — serial emit chains, slot
contention, an uncached editor bootstrap, cache-service latency, daemon waits —
belong to their owning subsystems; this lane only makes them visible and
measurable.
