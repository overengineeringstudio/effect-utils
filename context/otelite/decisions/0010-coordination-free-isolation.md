# Coordination-free concurrent isolation (validated) + required hardening

Many independent agents running otelite at once must be fully isolated with **no
cross-agent coordination**. An experiment validated this and pinned the model;
three hardening items are mandatory.

## Evidence (`tmp/otelite-compare/concurrency/`, 32-core box)

| K concurrent    | runs OK | bind fails | cross-contamination | collisions |
| --------------- | ------- | ---------- | ------------------- | ---------- |
| 1 / 20 / 50     | all     | 0          | 0                   | 0          |
| 100 / 200 / 400 | ≥90%    | 0          | **0**               | **0**      |

- Only per-run identity = **(ephemeral HTTP port + ephemeral gRPC port) + caller
  out-dir**. Shared-state audit clean: no fixed ports, PID/lock files, env reads,
  temp paths, signal/global state, or registry.
- Port headroom: ~14k simultaneous instances hard ceiling, low-thousands
  practical; no realistic exhaustion (K=400 added ~400 TIME_WAIT).

## Required hardening (the footguns found)

1. **Auto-unique default out-dir.** The prototype's fixed `./otel-capture`
   default is the _only_ coordination-forcer — two agents in one cwd collide.
   Default to a minted unique dir (`$TMPDIR/otelite-<random>`), always echo the
   resolved `.out`. Don't hard-require `--out` (hurts ergonomics).
2. **Defend a shared `--out`.** Open sink files with `create_new`/`O_EXCL` (or
   flock the dir) and **fail loud** rather than silently truncating a peer's
   capture (the prototype's `File::create` truncates → last-writer-wins).
3. **Durability: flush + `sync_all` on shutdown, and flush before the OTLP
   ack.** Under high K the prototype counted spans (HTTP 200, summary `spans:1`)
   that never reached disk — `tokio::fs::File` drop doesn't guarantee writeback.
   Writing the export to the sink **before returning the success response** is
   what makes the in-flight-drain guarantee real: an emitter that awaits its
   ack is then guaranteed its span is durably captured. Ties to `0006`.

## Latent

gRPC binds `:0`, drops the listener, then lets tonic re-bind the addr — a TOCTOU
window (didn't bite in ~970 runs). Hand tonic the already-bound listener.
