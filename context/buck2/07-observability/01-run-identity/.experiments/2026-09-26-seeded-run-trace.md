# Seeded pipeline-run trace and entrypoint bakeoff

Date: 2026-09-26. This is a sanitized account of the traceparent bakeoff and local-entrypoint follow-up; no machine, account, or workspace identifiers are retained.

## Question

A pre-seeded W3C run trace can represent one multi-job run without restitching, provided job keys distinguish matrix variants and only one writer emits the completed root. A generic task entrypoint can own local minting and root completion without hiding task failures.

## Method

Compare a three-job CI corpus (15 Buck commands) against independent task traces; replay root, job, task, command and critical-view spans, fetch by trace id and render. The attempted live seeded Buck aggregate did not execute because its resource gate never admitted it; replay with the shipped adapter demonstrated composition, not a live Buck round trip. Probe repeated root writes and late root appearance. Exercise a provider-neutral wrapper around a real lightweight devenv task on success and signals, compare a task-graph completion hook, inspect outgoing propagation, and measure wrapper overhead. For backend completeness, send the 6,255 spans as three bursts 20 seconds apart, compare by-id and backend-block reads under different live-store idle windows.

## Result

| Observation | Result |
| --- | --- |
| One seeded run | 6,255 spans, 2.36 MB; fetch 621 ms, render 1.6–2.1 s; one root, zero orphans after root arrival |
| Without run seed | 45 traces for the same run |
| Per-job alternative | Largest job 2,218 spans; fetch 282 ms, but no single run waterfall and fresh search entries lagged |
| Root timing | Writing one root per job produced three copies with incorrect duration. A late root repaired the trace view; early root bounds cannot be updated |
| Local wrapper | Run root → job → `devenv.task.exec`; root emitted on normal exit, SIGINT and SIGTERM; SIGKILL cannot be trapped. A corrected-wrapper `true` microbenchmark cost ~76 ms; paired full-task timing was noisy and was measured before the correction |
| Task finalizer | `@completed` cancelled on interruption and could mask task failures |
| Propagation | Pinned devenv replaced outgoing `TRACEPARENT`; current otel-span prefers `OTEL_TASK_TRACEPARENT`, so both seeds were needed for current task spans. Generic W3C SDK propagation remains incomplete until devenv honors inbound context |
| Tempo completeness | Under default 5-second live-store trace-idle flushing, two 20-second-gap trials returned 5,232/6,255 spans despite full OTLP acceptance; backend blocks also lacked the 1,023 middle-job spans. No-poll and 5-second-gap controls returned 6,255; a 2-minute idle setting eliminated the isolated reproduction. The precise internal loss point remains unproven |

A prototype hash collided, a job name alone conflated matrix jobs, retries made root bounds inconsistent, and an inherited task traceparent could override the intended seed. These are contract defects, not reasons to keep random task traces.

## Conclusion

Use one run trace per attempt with framed domain-separated deterministic ids, a matrix-qualified job key, and one root writer after completion. Mint local identity at the generic entrypoint, reconstruct missing roots after untrappable exits, and seed both environment variables only during the devenv transition. Whole-run persistence is conditional on verified by-id completeness after staggered job ingestion; a longer idle window is an isolated mitigation, not proof of production safety, and per-job traces are the fallback. See [decision 0002](../.decisions/0002-seeded-pipeline-run-trace.md) and [spec](../spec.md) for the normative contract.

## VRS Impact

The evidence establishes [BUCK.OBS.ID-R08..R13](../requirements.md) and
[decision 0002](../.decisions/0002-seeded-pipeline-run-trace.md).
The run identity precedes the sealed record's
[VCS metadata](../../02-run-record/spec.md); the Tempo persistence caveat
requires ingest-side readback and an indexed per-job fallback rather than
assuming an accepted OTLP batch is complete.
