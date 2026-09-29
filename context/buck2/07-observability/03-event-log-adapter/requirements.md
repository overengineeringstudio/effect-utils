# Event-Log Adapter Requirements

This subsystem owns the local post-hoc adapter that decodes native Buck event
logs into spans, including its vendored schema and bump policy, and
daemon-wait attribution among available local peer logs. It refines
BUCK.OBS-R01 and BUCK.OBS-R02 of the
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
  hazard), decodes the cross-version corpus fixtures, and lands as one
  reviewable change.
- **BUCK.OBS.ADP-R04 Unknown fields are data loss (refines BUCK.OBS-R02):**
  Unknown fields are skipped and counted per log; decoding never fails a
  build on content. A framing failure in a trusted local log may fall back to
  `buck2 log show` with the matching binary and warns about the mismatch.
  Untrusted fork logs use only the bounded Rust decoder: framing failures
  leave the local log and record the reason without spawning Buck.
- **BUCK.OBS.ADP-R05 Dedicated Rust crate:** The adapter is a new, dedicated
  Rust crate (prost) in the Buck-tooling workspace — not part of otel-scrape —
  shipped through cargo → Buck product → Nix like the other native tools.
- **BUCK.OBS.ADP-R06 Deterministic span model:** The same event-log bytes and
  local correlation context produce the same v2 names, parent edges,
  timestamps, critical-path membership, and per-command salted span ids
  (01); local retry cannot create a different trace identity.
- **BUCK.OBS.ADP-R07 Local daemon-wait attribution:** Post-hoc conversion
  attributes daemon waits among peer logs available in the same local job
  invocation, scoped by daemon-provided `ConcurrentCommands` trace ids.
  `DiceBlockConcurrentCommand` supplies exact attribution; otherwise inferred
  waits have causal producer ranking and confidence tiers, with links only
  when a peer log exists. Missing peers are not invented; each command retains
  its own gap summary. Default threshold 1 s (opt-in 500 ms). Conversion
  does not wait for a run-wide archive or ingest batch.
