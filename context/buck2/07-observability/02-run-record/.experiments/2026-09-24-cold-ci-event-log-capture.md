# Cold-CI event-log capture (CiCapture2)

Date: 2026-09-24 · A cold, force-cold-cache CI run (workflow_dispatch, 3 jobs
— Linux typecheck, Linux test, macOS test; run concluded failure in the macOS
test job only) on the public repository, with a temporary upload step for
`buck-out/*/log/*_events.pb.zst` (branch deleted after artifact download;
artifacts retained 14 days by the provider).

## Question

What does a cold CI run's Buck event-log evidence actually contain — per-job
commands, tasks, actions, execution mix, critical paths — and what do the
logs prove about capture cost, concurrent commands on shared daemons, and
what telemetry must correlate?

## Method

- Decoded all 15 event logs (5 per job: bootstrap build+uquery, publish
  build+uquery, unit test, vitest collect — the largest: the check aggregate
  at 2,160 actions / 12,622 spans / 711,142 compressed bytes) with the pinned
  Buck's `log show` + `critical-path`, cross-checked against the CI span
  spools.
- Attributed every log to its devenv task by start-time matching; produced
  per-category stage sums (queue / materialize-inputs / execute /
  prepare-outputs) and top-10 action tables for the slowest logs.
- Restitched each job's spool under a `ci.job` root and pushed the converted
  logs with per-task traceparents; verified exact readback counts and parent
  chains from the trace backend's JSON.

## Result

- Cold CI is compute and local-slot bound: the check aggregate's critical
  path is a serial chain of tsgo emit/typecheck actions (~165 of 204 s); 529
  - 543 pnpm store/extract actions queue 3,729 s (summed) behind 8 local
    slots while the tsgo actions run. No remote cache participated (0 B via
    RE — the force-cold posture); the only "hits" are same-daemon
    local-action-cache reuse.
- Concurrent commands share one daemon and the work lands on whichever
  command wins: the Linux unit-test command got 435 local-action-cache hits
  from the concurrent publish's work and spent 380 s (summed) with package
  trees _queued_; on macOS the roles reversed and the publish command spent
  446 s (summed) in materialization waiting for the test command's outputs.
  Per-command logs misattribute cost unless read together — the measured
  basis for both the daemon-wait join (03) and the task nesting.
- The largest CI task was mostly outside Buck at capture time (editor
  publish: 645.9 s task, 152.4 s Buck part — now covered by the merged #1382
  spans).
- Trace nesting `buck2.command ← devenv.task.exec ← ci.job` verified by exact
  readback counts for all six heavy traces (12,631 / 21,322 / 9,785 spans),
  zero dangling parents.
- Volume: full run = 3.61 MiB zstd logs / 66,948 spans / 60.09 MiB OTLP JSON
  (29,007 + 17,465 + 20,476 per job).

## Conclusion

Capture from cold CI is cheap, complete, and self-describing: one upload step
per job yields the full evidence set; the logs expose exactly where cold CI
time goes and how shared-daemon commands interact. The measured bottlenecks
belong to their owners (serial emit chain and slot contention → 02-execution;
uncached editor bootstrap → 03-materialization); this lane owns only the
correlation and measurement. Confidence: high (complete corpus, exact
readback).

## VRS Impact

Grounded the capture wiring (BUCK.OBS.REC-R02), the volume model
(BUCK.OBS-R06, [04](../../04-trace-views/requirements.md) shaping), the
daemon-wait motivation ([03](../../03-event-log-adapter/.decisions/0003-daemon-wait-at-ingest.md)),
and the task nesting verified in
[01](../../01-run-identity/.experiments/2026-09-25-caller-correlation-and-salting.md).
Findings cross-referenced into the owning subsystems' open questions (q8).
