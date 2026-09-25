# Buck2 Observability Intuition

_For: repository maintainers and tooling authors · Assumes: the buck2 VRS
intuition, OTel traces basics · Covers: how build telemetry flows and why it
is shaped this way_

Buck already records everything worth knowing: every command writes an event
log with the full span tree, per-action stages, cache outcomes, and the
critical path. Nothing here watches Buck from outside. The lane's whole job is
to move that existing truth to where it can be queried — without changing what
a build means.

The mental model is a pipeline over one portable unit:

```text
identity:  caller task -> command span -> wrapper trace id (Buck's BUCK_WRAPPER_UUID)
capture:   buck2 --event-log -> native evidence + span spool = run record
deliver:   seal -> upload (content-addressed, provider-neutral)
derive:    event-log adapter -> span model -> {full view, critical view} + bounded metrics
store:     Tempo 30 d (traces) · Mimir (trends) · archive ~1 y (raw records)
```

Three invariants hold at every stage. First, telemetry is derived, never
authoritative: delete Tempo, delete the archive, and every trace regenerates
from archived run records; a broken pipeline never rewrites a build result.
Second, CI is unspecial: the laptop and the CI runner run the same commands
through the same code and differ only in environment variables — which is why
delivery is "upload a sealed record" rather than any CI-provider artifact API.
Third, volume is the constraint, not overhead: capture costs single-digit
milliseconds, but a cold CI run produces ~67 k spans, so what lands in trace
storage is a bounded choice (two views, one capped) while the raw record keeps
everything.

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
