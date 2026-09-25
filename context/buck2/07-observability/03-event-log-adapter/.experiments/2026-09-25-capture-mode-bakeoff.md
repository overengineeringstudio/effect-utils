# Capture-mode bakeoff (B3)

Date: 2026-09-25 · Local-disk checkout of the repository; pinned Buck with a
long-lived warm shared daemon (not started by, and not killed by, this
bakeoff); n=5.

## Question

Which capture mode: (a) post-hoc conversion of an explicit per-invocation
`--event-log`, (b) live file following while the command runs, or (c)
upstream's proposed native OTLP event sink? Criteria: completeness on
success, failure, cancellation, crash; latency to first usable span;
shared-daemon correctness; operational risk; maintenance.

## Method

- Successful-build shape: `buck2 build --event-log <out> --write-build-id
<out> --console none <target>` with a concurrent `log snoop` follow after
  the first readable prefix, then post-hoc `log show` + adapter runs; n=5
  with per-run host load recorded.
- Edge cases: a failing target (same flags); two simultaneous commands on
  the shared daemon (own logs + build ids); five SIGINT and five SIGKILL
  attempts at 1 ms (warm target completed first — not a cancellation test);
  a second set on an owned fresh-isolation daemon; cancellation/crash
  semantics resolved from upstream source where the cheap target could not
  be interrupted.
- Upstream candidate (c) assessed from its PR diff (unmerged; exporter
  lifecycle + a 1,657-line mechanical InvocationRecord mapper) without
  building a custom binary.

## Result

- Success 5/5 (first run 222 spans / 42 actions, warm runs 8 spans / 0
  actions, all critical-path entries matched); failure exit 3 → complete
  log, 7 spans, no open spans; two commands on one daemon → two distinct
  build ids and independently decodable logs.
- Latency: event file readable 47 ms (median) after process start; post-hoc
  adapter 201 ms / 260 s-percentile on warm tiny builds. The follow surface
  attached, followed, and exited correctly on the final result — but it
  renders a console; it is not an event/OTLP API, and unattended streaming
  needs partial-span/reconnect/finalization semantics nobody needs yet.
- Cancellation: a SIGINT'd streaming client returns through the normal
  cleanup path; a dropped span closes as cancelled; a hard kill before the
  lazily-opened log's first byte leaves no artifact (observed exit 137/141 —
  a boundary of the writer, identical in every mode).
- Upstream (c): exports exactly one end-of-invocation wide-event span; no
  per-action hierarchy; unmerged with 2,300+ changed lines — not the lane's
  path, useful only as conventions evidence.

## Conclusion

Post-hoc conversion of the explicit per-invocation event log, correlated by
build id, is the V1 capture mode — the only tested mode complete on all
normal outcomes with the lowest operational risk. Live mode stays revisable
on three triggers (spans needed during a running command; a seconds-scale
partial-trace SLO; a stable machine-readable follow API). The native sink is
revisited only if it merges and changes shape.

## VRS Impact

Settled [decision 0002](../.decisions/0002-post-hoc-capture.md) (q10,
BUCK.OBS.ADP capture side; wiring lives in
[02](../../02-run-record/requirements.md) BUCK.OBS.REC-R02).
