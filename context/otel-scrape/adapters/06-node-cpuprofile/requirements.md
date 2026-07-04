# Requirements: node-cpuprofile adapter

Role: a supported profile/artifact adapter. Documented from the implementation
(`packages/@overeng/otel-scrape/src/lib.rs`), not part of the fleet audit. This
leaf states only node-cpuprofile-specific testable constraints.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and the parent
  contract [../../requirements.md](../../requirements.md).
- Governed by parent decision
  [../../.decisions/0006-cas-profile-artifact-uris.md](../../.decisions/0006-cas-profile-artifact-uris.md)
  (CAS profile artifact URIs).

## Requirements

- **ADP.NODECPU-R01 Profile artifact, not a parsed stream** (refines ADP-R01):
  the adapter's source is a native `.cpuprofile` artifact produced by the child,
  linked into the trace as a profile link — not events or spans parsed from
  output.
- **ADP.NODECPU-R02 CAS-backed, addressable** (refines parent R27): the profile
  is stored content-addressed (requires `--cas-root`/`OTEL_SCRAPE_CAS_ROOT`) and
  referenced by a CAS URI, so the artifact is shareable without embedding a local
  path.
- **ADP.NODECPU-R03 Live human output preserved** (refines parent R30): the
  child's stdout is captured for the profile flow **and** streamed live to the
  terminal, so profiling does not blank interactive output.
- **ADP.NODECPU-R04 Degrade when not node** (refines parent R07): if the wrapped
  command is not node or no `.cpuprofile` is produced, the adapter records a
  degraded reason rather than failing the run.
