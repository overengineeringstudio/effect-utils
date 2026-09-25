# Event-Log Adapter Requirements

This subsystem owns the versioned adapter (decision 0011's term) that decodes
Buck event logs directly into the span model, including its vendored schema
and bump policy, the post-hoc capture decision it consumes, and daemon-wait
attribution at ingest. It refines BUCK.OBS-R01 and BUCK.OBS-R02 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.ADP-A01 Unstable upstream schema:** Buck upstream explicitly
  promises no event-log schema stability; the format is protobuf with normal
  field-number evolution plus occasional same-number type changes.
- **BUCK.OBS.ADP-A02 Fleet producer set:** the vendored schema pins the
  newest Buck binary actually producing logs in the fleet; older writers'
  logs remain readable because evolution has been field-number-additive.

## Acceptable Tradeoffs

- **BUCK.OBS.ADP-T01 One schema pin:** all producers share one vendored
  proto; per-writer schemas are not maintained (a diverging fleet would force
  them).
- **BUCK.OBS.ADP-T02 Inferred waits in traces:** daemon-wait spans are marked
  derived evidence (confidence tiers); exact attribution is used whenever the
  event exists.

## Requirements

- **BUCK.OBS.ADP-R01 Direct decode (refines BUCK.OBS-R01):** The adapter
  decodes `*_events.pb.zst` directly — one zstd stream of varint
  length-delimited protobuf records (`Invocation` header, then
  `CommandProgress`) — streaming, without spawning any Buck binary, with the
  critical path arriving in-band.
- **BUCK.OBS.ADP-R02 Vendored pinned schema:** `data.proto` (and its
  dependencies) are vendored pinned to the newest fleet producer; decoding
  tolerates truncation exactly as upstream does (stop at the last complete
  record, mark truncated).
- **BUCK.OBS.ADP-R03 Bump policy:** Every Buck version bump regenerates the
  vendored schema and diffs both field numbers _and types_ (a measured
  `bool → enum` retag at a stable field number shows type drift is the real
  hazard), replays the cross-version corpus, and lands as one reviewable
  change.
- **BUCK.OBS.ADP-R04 Unknown fields are data loss (refines BUCK.OBS-R02):**
  Unknown fields are skipped and counted per log; a framing failure falls
  back to `buck2 log show` with the matching binary and alerts on the
  mismatch. A decode never fails a pipeline stage on content.
- **BUCK.OBS.ADP-R05 Dedicated Rust crate:** The adapter is a new, dedicated
  Rust crate (prost) in the Buck-tooling workspace — not part of otel-scrape —
  shipped through cargo → Buck product → Nix like the other native tools.
- **BUCK.OBS.ADP-R06 Deterministic span model:** The same bytes produce the
  same spans: v2 span names, parent edges, timestamps, critical-path
  membership, and per-invocation salted span ids (01). Re-running ingest is
  idempotent.
- **BUCK.OBS.ADP-R07 Daemon wait at ingest:** Ingest attributes daemon waits
  by joining the run's logs: peers scoped exactly by the daemon-provided
  `ConcurrentCommands` trace-id list; a `DiceBlockConcurrentCommand` span read
  directly as exact attribution; otherwise inferred daemon-wait spans with
  causal producer ranking, confidence tiers, and producer links. Default gap
  threshold 1 s (opt-in 500 ms); gap summary attributes always on the command
  span as the degradation floor. An upstream dice-hook track runs in
  parallel and never gates this design.
