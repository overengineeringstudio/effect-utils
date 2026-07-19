# DELTA-002: Prepared v18 artifacts still contain bin projections

Status: open

## Divergence

The accepted prepared-v18 contract requires `.bin` projection directories to be
excluded and rejected by the strict scan. Current realized prepared artifacts
still archive dozens of `.bin` directories and the implementation rewrites them
after restore.

## VRS

- [Decision 0002](../.decisions/0002-effect-utils-owned-bin-projection.md)
  assigns bin projection to the effect-utils projector rather than prepared
  dependency data.
- [Decision 0004](../.decisions/0004-strict-prepared-scan-v18.md) requires the
  v18 prepared artifact to strip and reject `.bin` immediately.
- [The root spec](../spec.md) classifies `.bin` as Projection State and requires
  the strict prepared scan to reject it.

## Implementation

`nix/workspace-tools/lib/mk-pnpm-deps.nix` currently strips pnpm bookkeeping but
does not strip or reject `.bin`; its restore path still chmods/rewrites archived
bin projections. Realized `genie-pnpm-deps` and `megarepo-pnpm-deps` artifacts
contained 48 and 51 `.bin` directories respectively, while neither contained
`.modules.yaml`, `.pnpm/lock.yaml`, or native `*.node` files.

## Resolution Approach

Make normalization remove `.bin`, make the strict scan fail on any remaining
bin directory or shim, and recreate bins exclusively through the accepted pure
projector after immutable data is realized. Refresh the affected fixed-output
hashes through Evergreen and prove the exact prepared artifacts.

## Direction

update implementation

## Resolution Signal

- Realized prepared v18 artifacts contain zero `.bin` directories/shims and
  pass the strict scan.
- Restore no longer chmods or rewrites archived bins.
- The pure projector recreates all expected scoped, aliased, package-local, and
  platform-correct bins from immutable package manifests.
- Exact prepared builds and downstream CLI consumers pass on Linux and Darwin.
- This delta is removed.
