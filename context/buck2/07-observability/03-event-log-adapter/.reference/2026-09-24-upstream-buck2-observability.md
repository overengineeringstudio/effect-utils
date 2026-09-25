# Upstream Buck2 Observability Research

Source: facebook/buck2 source tree, documentation, and PR/issue tracker at
commit `b32ed8ac` (2026-09-24), plus the logging/build-report observability
docs and PR #811/#995/#1370 and issue #1316 as cited; retrieved 2026-09-24
by the observability-lane research track.

Date: 2026-09-24. The fleet's pinned binary is the unstable-2026-09-01
release. Cited by the adapter decisions
([0001](../.decisions/0001-direct-decode-rust-crate.md),
[0002](../.decisions/0002-post-hoc-capture.md)).

## What the event log contains

- Framing: `Encoding::PROTO_ZSTD` — length-delimited `Invocation` header,
  then `CommandProgress` records (`BuckEvent` / `PartialResult` /
  `CommandResult`); the reader accepts JSON/gzip variants but the default
  artifact is protobuf+zstd. Every `BuckEvent` carries wall timestamp, trace
  UUID, 64-bit span id, parent span id, and a span-start/end/instant/record
  oneof.
- Per-action depth: `ActionExecutionEnd` (key, kind, digests, wall time
  excluding queue, command attempts with queue/materialization/hashing
  timings), `ExecutorStage` spans (local queue/execute/materialize-inputs/
  prepare-outputs; RE queue/execute/download/upload; cache query/hit),
  execution kinds, scheduling modes, cache-hit types, upload digests/bytes.
- `BuildGraphExecutionInfo` carries `critical_path2` **and** `slowest_path`
  in one instant event (ideal lower bound vs. actual-path explanation), with
  per-entry user-improvable time and queue duration.
- Periodic `Snapshot` events (daemon RSS/CPU, executor and DICE queues, RE
  and cache counters, network); a final `InvocationRecord` aggregate
  (opt-in JSON, "no guarantees whatsoever").
- Wrapper contract: `BUCK_WRAPPER_UUID` supplies the caller-chosen trace id;
  otherwise a v4 UUID per command.
- Offline analyzers: `log show/summary/critical-path/slowest-path/what-ran/
what-failed/what-up/what-materialized/what-uploaded/diff`, the
  Perfetto-compatible chrome-trace converter, `log replay` (Superconsole
  re-render), `log snoop` (live tail), `log shed select-events`.

## What does not exist upstream

- **No native OTLP:** no OpenTelemetry crates or `OTEL_*` handling in the
  inspected tree. PR #1370 proposes an `OtelEventSink` exporting **one**
  `InvocationRecord` wide-event span (unmerged; also a community fork PR).
  Scribe is Meta-internal, a compile-time no-op in OSS, and
  selective/truncating even at Meta — the local log is richer.
- **No BES/BEP:** PR #811 (draft adapter, "very few" events translated) and
  #995 (bindings only) are unmerged; commercial BEP UIs cannot receive
  official invocations.
- **No schema stability:** the logging docs state all schemas may change;
  the build report is "generally stable" at best; JSONL inherits the
  protobuf's instability.

## Relevant Facts

- The per-command event log is the authoritative OSS observability surface;
  per-action, per-stage, critical/slowest-path, and cache fidelity all
  arrive in-band in one artifact.
- No shipped or merged upstream path exports the BuckEvent hierarchy to
  OTel or BES; an external version-pinned converter is the only practical
  bridge.
- The wrapper trace id (`BUCK_WRAPPER_UUID`) is upstream's own correlation
  seam, documented in the wrapper common library.
- Server-side RE/cache metrics (bazel-remote Prometheus, NativeLink OTel)
  complement but cannot reconstruct the client's critical path or per-action
  timeline.

## VRS Impact

Grounds the direct-decode decision (vendored pinned schema, upstream's
instability warning, the in-band critical path that deletes a second
subprocess) and the post-hoc capture decision (PR #1370's shape — one
wide-event span — is not the lane's path). Upstream OTel/BES PRs are watch
items, not dependencies.
