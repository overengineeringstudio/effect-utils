# Event-Log Adapter Spec

This document specifies local post-hoc decoding, schema policy, span model,
and peer-log daemon-wait join. It builds on [requirements.md](./requirements.md)
and feeds [04-trace-views](../04-trace-views/spec.md).

## Status

Draft.

## Scope

**Defines:** local decode pipeline and framing, vendored-schema layout and
bump procedure, fallback, the span model's identity rules, and daemon-wait
attribution over available peer logs.

**Does not define:** view selection rules (04), direct OTLP transport (05),
or the upstream contribution.

## Decode Pipeline

```text
*_events.pb.zst
  -> streaming zstd decode
  -> varint length-delimited records
       record 1: buck.data.Invocation header (command_line_args[0] = writer version)
       2..n:    CommandProgress { BuckEvent | PartialResult | CommandResult }
  -> vendored prost types (data.proto + error.proto + host_sharing.proto
                           + subscription.proto + daemon.proto, ~190 KB)
  -> span model: span tree, v2 names, per-command salted ids,
     in-band critical_path2 / slowest_path from BuildGraphExecutionInfo
  -> truncation: stop at last complete record; flag `truncated`
```

Performance envelope (measured on the largest fleet CI log, 711 KB
compressed / 12,622 spans): 42 ms wall / 13.7 MB RSS streaming decode — at
the zstd floor, ~165 MB/s warm, batchable (22 logs in 343 ms in one process),
2.5 MB static-linked binary depending only on libc/libgcc. The fallback
(`log show`) costs 59 ms but pins a 136 MB Buck binary and re-keys with the
_reader's_ proto (a measured misrendering hazard), so it is fallback-only.

## Span Model

- **Names (v2):** `buck2.command <subcommand>`, `buck2.action <category>`,
  `buck2.stage <executor stage>`, `buck2.materialization`, plus
  `buck2.critical_path=true` membership attributes and instant error events.
- **Identity:** OTLP span id is the first 8 bytes of
  `sha256("<log-uuid>:<buck-span-id>")` (salting,
  [01](../01-run-identity/spec.md)); local sidecar context supplies the
  caller's job trace and command parent. Without it the adapter derives an
  independent command trace from log identity.
- **Completeness:** the decoded field set is a superset of the `log show`
  JSONL (same bytes, typed); cache-upload results, action digests, execution
  kinds, stage timings, and materialization byte counts all map (per-field
  corpus hit counts recorded in the decode bakeoff).
- **Cache-hit classification:** each action's first end sets `buck2.execution_kind`
  and `buck2.cache_hit`; the same classification produces the command summary
  hit counts ([04](../04-trace-views/spec.md#command-summary-attributes)).
  `buck2.execution_outcome` separately describes native execution evidence:
  local/local-worker → `local-exec`, remote/remote-worker → `remote-exec`,
  action-cache/local-action-cache/remote-dep-file-cache/local-dep-file →
  `cache-hit`; all other kinds and any failed action → `unknown`. Local
  dep-file reuse does not change the existing action-cache summary counters.
  Neither cache reuse nor
  deferred execution proves coalescing, so this writer emits no `coalesced`
  outcome.
- **Occurrence evidence:** `buck2.occurrence_id` is `occurrence-sha256-v1:<lowercase SHA-256 hex of "<log-uuid>:<native-span-id>">`, independent of view/context.
  `buck2.action_digest` is the last nonempty native command-attempt digest (local, omitted-local, worker or remote), never derived from a label/action key.
  Native end evidence supplies writer `buck2.action_host`, wall `buck2.duration_ns`, execution/queue timings and logical output `buck2.total_bytes`.
  Execution prefers native execution time, then action wall time; bytes mirror `output_size`, never network traffic or input-plus-output size.
  Missing optional evidence stays absent (explicit zero survives); unfinished actions get identity, not invented end evidence.
- **Opaque checkout identity:** nonempty native `working_dir` supplies resource `buck2.root_id = lowercase-hex(SHA-256(UTF-8(working_dir)))`.
  Paths/argv are not exported; missing directory means missing identity. This is the native invocation directory, not an independently discovered repository root.
- **View evidence boundary:** summaries/producer metrics precede critical pruning; retained actions have identical evidence across views, and full retains every decoded span.
  Critical pruning, truncation, decoder limits and mandatory overflow remain explicit gaps; none certify gap-free cross-invocation history.
- **Command outcome:** `buck2.is_success` comes from the final `CommandResult`,
  not the deprecated `CommandEnd.is_success` (unset by current writers).
  Top-level errors fail; build/BXL responses succeed only with no errors;
  targets responses require zero errors; test responses require no build
  errors and a zero executor exit code. Other typed responses succeed.
  Without a final typed response the attribute is absent, not false.
  Both trace views preserve the same outcome.
  The outcome fixtures retain only native command boundaries and the final
  response: `successful-build.pb.zst` projects the existing `local-build.pb.zst`;
  `failed-build.pb.zst` captures `buck2 build //:missing` in an empty root
  using the pinned 2026-09-01 writer. Headers, argv, metadata, target lists,
  response paths and error text are stripped or sanitized; outcome fields
  retain their native wire presence.

## Compact local occurrence evidence

```text
wrapper open -> native Buck -> wrapper terminal
native log -> compact durable projection -> existing OTLP spool -> export
```

`buck2-events` owns `${XDG_STATE_HOME:-$HOME/.local/state}/buck2-events/occurrence-records/v1`,
outside disposable worktrees. Supported Buck task wrappers persist
`census --invocation-id ID --phase open --host HOST` before execution and
`--phase terminal --build-id NATIVE_UUID --exit-code CODE` afterward; a missing
native build ID is omitted, never synthesized. `--capture-error` on the terminal
records a failed open write. The census does not require a native log or OTLP.
`ingest --records-dir DIR` and `census --records-dir DIR` override the state root
for isolated tests/operator capture; normal callers share the default.

Every immutable JSONL file is atomically published and synced before ingest
acknowledges conversion. Conversion filenames include native-build and content
hashes, so replay is idempotent while partial and later complete snapshots coexist.
First use syncs the entire newly established directory ancestry before creating
an owned `.directory-synced` marker. Later publications sync their file and leaf
directory; concurrent creation or a lost marker cannot skip the ancestry barrier.
The conversion header carries `build_id`, `root_id`, typed `resource_attributes`,
`truncated`, `stop_reason`, `unknown_fields`, and `action_count`. Each following
`occurrence` carries `build_id`, `span_id`, decimal-string `start_ns`/`end_ns`,
`ended`, and allowlisted typed OTLP `attributes`. Only native action spans enter
this projection, not command roots, raw argv, environment, paths, or full traces.
`retained.rs` is the format/allowlist authority; absent attributes stay unknown.

Census records carry `invocation_id`, `phase`, observed `host`, decimal-string
`timestamp_ns`, nullable `build_id`/`exit_code`, `capture_error`, `run_id`, and
`lane`. Local lane is `supported-entrypoint/local`; CI without a supplied native
lane stays null. Host manifests carry `enrolled_at_ns`, `retention_seconds`,
`scope: supported-entrypoints`, and `coverage: unknown-until-reconciled`.
They establish enrollment, not continuous fleet coverage.

Records remain at least 30 days from first durable capture; replay does not
refresh that clock. A host-wide scan is claimed at most once per UTC day and
prunes only expired records, never manifests or younger records.
A conversion is capped at 64 MiB; overflow/I/O errors fail ingest
so native input remains available. There is no silent size eviction or claim of
unlimited disk capacity. Existing OTLP delivery remains diagnostic until the
reader reconciles census opens, terminals, and converted native build IDs.
Unmatched opens, missing mappings/conversions, capture errors, truncated/conflicting
snapshots, unknown native fields, unsupported entrypoints and unenrolled hosts
must remain unknown, not zero. Operator 24-hour per-host counts reconcile exact
retained snapshots through the existing join reader/read authority, not Tempo
counts or CI's public artifact credentials. Worktree teardown must not remove
this host-owned evidence; no new daemon, remote store, exporter or transport
service is introduced.

Backfill retained native logs without fabricating historical census:

```sh
buck2-events ingest /preserved/run_events.pb.zst --spool-dir /existing/otel/pending
```

Inputs are zstd-compressed, varint-length-delimited protobuf: first
`buck.data.Invocation`, then `buck.daemon.CommandProgress` records. JSON from
`buck2 log show` is not accepted by this command. Select every preserved input in
the requested window without sampling; native timestamps govern reader windows,
not capture time. Backfilled occurrences remain observed-only under unknown
coverage when independent wrapper census is absent. Ingest queues existing OTLP
chunks but does not require or invoke export.

Conversion, census and enrollment snapshots also queue through the existing typed
OTLP chunk spool as logs (`/v1/logs`). Census `--spool-dir` selects the same pending
directory used by ingest/export; pipeline closure owns later export. Each log body
is a JSON string `{type:"buck2.occurrence.ledger",version:1,snapshotSha256,ordinal,recordCount,line}`:
SHA-256 covers the exact LF-terminated retained JSONL bytes, ordinal is zero-based,
recordCount includes every line, and line is exact UTF-8 without its final LF.
Reassemble `line + "\n"` in ordinal order and verify the hash before reconciliation.
Resources carry the snapshot's observed `host.name`, `service.name=buck2-events`,
and scope `buck2-events.occurrence-ledger`; outer timestamps are emission time,
while exact native epoch-nanosecond strings remain inside the original line.
Envelope bodies exceed neither 8 KiB nor 12 KiB as serialized OTLP log records;
resource metadata is bounded to 4 KiB. Oversize fails with unknown coverage and
retains source; no row is silently dropped or truncated.

HTTP acceptance can delete pending chunks but never proves downstream durability.
`buck2-events export --replay-records [--records-dir DIR] --spool-dir DIR` repairs
downstream loss from retained snapshots, without decoding native logs or a timer.
Replay fails explicitly on 100,000 scanned entries, 512 MiB source/queued bytes,
or the shared export time budget, and reports counters; it never silently samples.
Normal export does not scan 30 days of sources. Transport loss, rejection,
truncation, incomplete snapshots and conflicts remain unknown until reconciled.

Native replay regressions reconstruct acknowledged snapshots byte-for-byte,
including their LF/hash envelope identity, and assert source preservation when
line framing, envelope size, source-byte limits or the replay deadline fail.

## Producer Metrics

```text
CommandStart.metadata -> trace + metric host resource
ActionExecutionEnd.commands -> explicit execution / queue durations
LocalQueued / WorkerQueued completed intervals -> missing queue-duration fallback
  -> bounded per-category histogram -> durable metrics chunk -> OTLP export
```

The metric resource shares the trace resource's writer metadata mapping:
`hostname` → `host.name`, `os` → `os.type`, and `arch` → `host.arch`, alongside
`service.name=effect-utils-buck2`. These describe the machine that produced
the log, not the post-hoc converter. Missing metadata stays absent; the adapter
does not substitute the converter's host. Build IDs, revision, materializer,
and pipeline identity remain trace-only.
Both signals also set `service.instance.id` to that same writer `hostname`,
stable across builds and bounded per host, not per process or build. Together
with `service.name`, this keeps writer hosts distinct through delta conversion
and OTLP backends that map service identity to Prometheus `job` / `instance`.
Absent writer host metadata leaves both host and instance identity absent.

Queue timing prefers each command attempt's `metadata.queue_duration`, then
the remote command's `queue_time`, summing available attempt timings. When no
explicit timing exists for an action, completed local `LocalQueued` and
`WorkerQueued` intervals under that action supply the duration. The nearest
action ancestor owns the interval. Explicit zero is authoritative; fallback
intervals are not added to explicit timing. Repeated ends count once and
unclosed queue spans do not supply a measured duration. Actions with no queue
evidence produce no queue observation, rather than a fabricated zero.

Local queue stage names are `buck2.stage local_queued` and
`buck2.stage worker_queued`; other local stages remain `buck2.stage local`.
The queue instrument is `buck2.action.queue.duration` (seconds), with only
the existing closed `category` point dimension. Empty data-point arrays do
not create backend metric series. Conformance covers the retained local log
and synthetic local/worker queues, explicit timing precedence (including
zero), incomplete spans, repeated ends, and writer-host resource parity.

## Schema Bump Procedure

1. On a Buck version bump: fetch the pinned tag's protos, regenerate.
2. Diff field numbers _and declared types_ against the previous pin
   (the 2026-04 → 2026-08 drift was field-number-additive but retagged
   `did_cache_upload: bool → cache_upload_result: enum` at stable numbers).
3. Decode retained local cross-version fixtures (older writers' logs) and
   truncation fixtures; no remote archive is required.
4. Land regeneration + diff + fixture results as one change.

## Daemon-Wait Join

```text
inputs:  event logs available in the local job at post-hoc conversion
scope:   peers = ConcurrentCommands.trace_ids[] among available logs (exact,
         daemon-provided); time-overlap is never the default scope
exact:   a DiceBlockConcurrentCommand span covering a gap -> emit the wait
         with the event's own current_active_trace_id as owner
inferred: gap (default >= 1 s; 500 ms opt-in) in waiter W with no W-owned
         action inside; candidate producers = peer actions overlapping the
         gap, identity absent from W, ending within 10 ms of wake-up;
         primary = the causal end (<= wake-up, closest), others co-producers
tiers:   exact <= 0.1 ms alignment · high <= 1 ms · medium <= 10 ms
always:  gap summary attributes on the command span (count, total ms, max ms)
         — the per-log floor that needs no batch
ids:     wait span id derived from waiter command key + gap start
         (deterministic; re-joins idempotent)
```

The adapter converts after Buck exits and before job-end OTLP export. A job
may have multiple commands on one daemon; only locally available logs can
contribute producer evidence. A daemon-provided peer trace id absent from the
local batch stays unattributed, with a per-log gap summary. Conversion does
not await an archived record, other CI jobs, or a server-side ingester.

Measured on a 43-log corpus: precision 0.957 / recall 1.0 at 500 ms; P = R =
1.0 at 1 s (six true sub-second waits traded away); ms-level cost inside the
Rust adapter (the Python prototype did 41 logs in 3.0 s). Known blind spot: a
_busy_ waiter (lanes starved while others run) shows no silent gap — only
the upstream dice-hook track can fix that class; it is filed in parallel and
does not gate this design.

## Fallback and Failure Behavior

| Condition                        | Behavior                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| Unknown fields                   | Skip; count bytes/fields per log                                   |
| Framing damage / schema conflict | Trusted local log: matching-binary `buck2 log show` fallback; warn |
| Untrusted fork log               | No external process; retain local log and recorded failure reason  |
| Truncated log (crash)            | Decode readable prefix; mark truncated; infer end semantics        |
| Missing sidecar line             | Independent command trace keyed by log UUID                        |

## Conformance

- Corpus sweep: retained local fixtures decode across writer versions;
  the 15/15 reader×writer cross-matrix stays green on bumps.
- Truncation fixtures: cut logs at 60–69% decode every complete record.
- Join: reproductions for exact (DiceBlock), inferred single-producer,
  multi-producer (causal primary + co-producer link), and negative
  (serial/cached) cases; end-to-end trace readback with the wait span
  parented and linked.
- Evidence: the five bakeoffs below and decisions
  [0001](.decisions/0001-direct-decode-rust-crate.md)–
  [0003](.decisions/0003-daemon-wait-at-ingest.md).
