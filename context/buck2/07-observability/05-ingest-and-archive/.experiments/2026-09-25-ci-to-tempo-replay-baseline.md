# CI-to-Tempo replay baseline (B7)

Date: 2026-09-25 · Fleet dev host; live collector + trace backend; corpus: a
real cold 3-job CI run (15 event logs + 3 span spools), re-downloaded live
from the CI provider for the end-to-end pass; n=5 per phase.

## Question

Which transport puts CI telemetry into the trace backend: (a) fleet-host
replay of completed runs' CI artifacts, (b) direct OTLP from runners, or (c)
an object-store relay? Define run/job correlation, idempotency, retention,
and the fork trust boundary.

## Method

- A download→restitch→convert→push→verify pipeline for a run id: fetch jobs,
  artifact list, and artifact zips (8 requests, 3.93 MB); convert each event
  log with the scratch converter; assign logs to devenv tasks by the
  serial-command invariant (a task runs its commands serially, so
  time-overlapping commands cannot share a task; longest-first assignment,
  fallback max-overlap, then the job root); push in chunks; verify by
  trace-by-id readback.
- Idempotency: ids derived solely from artifact-borne identity (trace id =
  digest of a run-key string; command ids salted per log; spool ids
  preserved); three consecutive full pushes compared; a salt bump used as
  the re-push escape hatch.
- Search-behavior probes: attribute-typed search over fresh vs flushed
  blocks; visibility polling after push; querier behavior under load.
- Candidates (b) and (c) assessed from runner topology, secret availability
  on fork runs, the cache-posture decision's trust language, and the current
  unauthenticated gateway posture.

## Result

- End-to-end (a): download 5.0 s median; restitch+convert 4.3 s; push 0.8 s
  (22 chunks; single ~28 MB bodies are rejected with HTTP 400 — chunks of
  ~4 k spans / ~3.5 MB pass); total 10.4 s / 11.1 s p90; readback 11.5–13.9 s
  per job (17–29 k spans). Exactly one `ci.job` root per trace, zero
  dangling parent ids, every `buck2.command` under its task span; span
  counts matched exactly (29,109 / 20,485 / 17,554).
- Log→task assignment 15/15 against the round-1 manual identification.
- Idempotency: three pushes → stable readback, no duplicate span entries;
  the salt bump produced the expected distinct traces (re-push escape hatch
  works; old blocks persist until retention — hence skip-if-processed in
  production).
- Backend findings: int-typed `ci.run.id` matches neither string nor int
  TraceQL equality while the legacy tag endpoint lists it (fixed in the
  prototype by string-typing); fresh pushes stay attribute-search-invisible
  ≥ 22 min (trace-by-id immediate); some heavy searches 500 with timeout and
  need retry/backoff. API cost is negligible (8 req/run; a 5-min poll adds
  288 req/day against a 5,000/h budget).
- Forks: artifacts upload under the fork's own token with no runner secret;
  bytes are attacker-controlled (the bounded decoder + caps are mandatory);
  telemetry poison is data-only and filterable by provenance. (b) loses the
  fork case structurally (secrets withheld from fork workflows; public
  no-auth ingest invites poisoning) and would widen the currently
  unauthenticated gateway; (c) is (a) with a bucket, credentials, and
  lifecycle rules for zero new capability at current scale.

## Conclusion

As a _mechanism_ the replay works and its numbers stand (correlation,
idempotency, chunking, backend quirks all transfer to the record ingester).
As a _design_ it lost the CI-agnostic bakeoff on provider coupling and
retention (14-day artifact window vs 1-year archive) and is recorded as the
rejected baseline; the record-upload ingest (05) inherits its verified
far-side mechanics. Confidence: high on measured numbers and API cost;
medium on backend search behavior (root-caused symptomatically).

## VRS Impact

Evidence for [decision 0001](../.decisions/0001-ingest-parity-and-retention.md)
(q14/q18) and BUCK.OBS.ING-R01/R02/R06 (chunk size, string-typed ids,
search-independent discovery). The fork findings fed 02's trust-signal
decision ([0002](../../02-run-record/.decisions/0002-untrusted-run-trust-signal.md)).
