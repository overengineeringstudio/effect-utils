# 0002: effect-utils-owned bin projection

Status: Accepted

## Context

Dependency materialization forbids lifecycle scripts. Strict pnpm installs can
leave missing or stale `.bin` entries, while prepared dependency artifacts must
exclude `.bin` entirely. The projection layer needs pnpm-compatible executable
links without making pnpm lifecycle execution or install-time side effects part
of the trust boundary.

## Decision

Effect-utils owns the production bin projector.

The projector implements pure manifest-based linking over an already-realized
`node_modules` graph. It reads package manifests, resolves `bin` and
`directories.bin`, validates targets, creates profile-owned `.bin` entries, and
emits projection reports.

pnpm's published bin-linking packages are used as conformance oracles in tests,
not as the runtime authority.

## Rationale

- pnpm's current linker package is small but pulls in pnpm internals, logging,
  manifest readers, workspace readers, command-shim code, and Node engine
  constraints.
- The effect-utils boundary needs a stable projection contract independent of
  pnpm's install implementation details.
- pnpm behavior still matters for compatibility. The conformance fixture keeps
  scoped command names, `directories.bin`, path-safety checks, conflict
  behavior, and missing-target handling visible.

## Consequences

- The implementation must cover pnpm-compatible bin edge cases intentionally
  rather than using an overly narrow string/object-bin shortcut.
- Native or generated CLI targets remain outside projection. They need a Nix
  native package integration or pure package artifact classification.
- pnpm linker package upgrades are test-oracle updates, not production behavior
  changes.
