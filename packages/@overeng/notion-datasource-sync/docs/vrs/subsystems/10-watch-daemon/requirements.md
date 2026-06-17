# Watch Daemon Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **DAEMON-R01 Local daemon:** `sync --watch` must run a local daemon with the same planner and guards used by one-shot commands.
- **DAEMON-R02 Poll overlap:** Remote polling must query from the latest complete checkpoint high-watermark with an inclusive overlap window and dedupe by materialized hashes.
- **DAEMON-R03 Known-page scan:** The daemon must maintain and periodically verify the known-page set with a complete full-membership scan so query absence can become a tombstone candidate.
- **DAEMON-R04 Backpressure:** The daemon must bound queues, honor Notion rate limits, and surface stuck commands.
- **DAEMON-R05 Lease fencing:** Only one logical writer may settle commands for a sync root at a time; stale leases must be fenced.
- **DAEMON-R06 Repair scans:** Periodic repair scans must detect missed events, projection drift, orphaned files, unresolved tombstone candidates, and any drift hidden by incremental polling windows.
- **DAEMON-R07 Local-first push latency:** When local SQLite CDC or runnable outbox work exists, watch mode must plan and attempt guarded outbound work without waiting for a full remote pull. Remote preflight and read-after-write guards still apply.
- **DAEMON-R08 Incremental absence safety:** High-watermark, filtered, capped, interrupted, or partial query results must not create disappearance or tombstone candidates. Only complete full-membership scans can provide query-absence evidence.
- **DAEMON-R09 Query payload hydration:** If the data-source query payload contains the complete row property values needed for hashing, observation must use those inline values and avoid per-row page retrieval. It may fall back to page retrieval only when inline payloads are missing or incomplete.
- **DAEMON-R10 Worker/webhook optionality:** Notion Workers and webhooks may provide optional invalidation/projection inputs but must not replace local reconciliation or SQLite authority. `sync --watch --webhook manual|tailscale` must start a local receiver, enqueue durable SQLite signals, wake the daemon after successful enqueue, and continue polling in degraded provider mode unless the user requested `--webhook-required`.

## Acceptable Tradeoffs

- **DAEMON-T01 Polling first:** Local daemon polling is acceptable before webhook support if overlap windows, dedupe, repair scans, and direct tombstone verification are implemented.
