# Spec: node-cpuprofile adapter (supported)

This document specifies _how_ the `node-cpuprofile` adapter works. It builds on
its [requirements.md](./requirements.md), the fleet [../spec.md](../spec.md), and
the parent adapter contract [../../spec.md](../../spec.md). Content is derived
from the implementation; this adapter was not re-investigated in the fleet audit.

## Status

Active (supported). Implemented in `packages/@overeng/otel-scrape/src/lib.rs`
(`NODE_CPUPROFILE_ADAPTER`, `prepare_node_cpuprofile_dir`, `ProfileLink`).

## Sources of truth

| Concern                    | Source of truth                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured-source contract | node `--cpu-prof --cpu-prof-name=CPU.cpuprofile` → a V8 `.cpuprofile` artifact (Node.js upstream format)                                                                                                                                                          |
| Adapter implementation     | `packages/@overeng/otel-scrape/src/adapters/node_cpuprofile.rs` — `NodeCpuProfileAdapter` impl of `ToolAdapter` (`prepare`/`discover_artifacts`/`cleanup_artifacts`/validate; `TeeLive`); registered in `src/adapters/mod.rs`; CAS write via `content_address.rs` |
| Telemetry constants        | `context/otel-scrape/telemetry-registry.json` (`profileFields`, `profile_type`/`profile_digest` attrs) → generated `src/telemetry_registry.gen.rs` (genie)                                                                                                        |
| Call-site wiring           | invoked ad hoc with `--adapter node-cpuprofile --cas-root <dir>` (no standing devenv task); requires `--cas-root`/`OTEL_SCRAPE_CAS_ROOT`                                                                                                                          |
| Governing decisions        | parent [0006](../../.decisions/0006-cas-profile-artifact-uris.md) (CAS profile URIs), [0009](../../.decisions/0009-rust-cas-module-boundary.md)                                                                                                                   |

## Source (profile artifact)

- **Flags injected:** `--cpu-prof --cpu-prof-name=CPU.cpuprofile` (plus a prepared
  `--cpu-prof-dir`), so node writes a V8 CPU profile into an otel-scrape-owned
  directory. Requires `--cas-root` or `OTEL_SCRAPE_CAS_ROOT` (ADP.NODECPU-R02);
  otherwise the invocation is a usage error.
- **stdout:** captured for the profile flow **and** streamed live to the terminal
  (`AdapterStdoutOwnership` live-tee), preserving interactive output
  (ADP.NODECPU-R03).

## Records (classification ladder)

| Record       | Kind    | Derivation                                                                                         |
| ------------ | ------- | -------------------------------------------------------------------------------------------------- |
| profile link | Profile | the `.cpuprofile` artifact written to CAS, referenced by a CAS URI (`profile_type = "cpuprofile"`) |

No spans or events are derived from the profile bytes; the profile is a linked
artifact (classification-ladder "native profile file" row).

## Degradation

If the child is not node, or no single `.cpuprofile` is produced, the adapter
records a degraded reason (`profile_type` present, `message` explaining the
degrade) rather than failing the run (ADP.NODECPU-R04).

## Open design questions

- **DQ-nodecpu-1:** retention/pinning policy for CAS profile artifacts across
  many runs (`--cas-pin`); out of scope for this leaf, governed by parent
  decision 0006 and the CAS module.
