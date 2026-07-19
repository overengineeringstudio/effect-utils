# 0002: effect-utils-owned bin projection

Status: accepted

## Context

Dependency materialization forbids lifecycle scripts. Strict pnpm installs can
leave missing or stale `.bin` entries, while prepared dependency artifacts must
exclude `.bin` entirely. The projection layer needs pnpm-compatible executable
links without making pnpm lifecycle execution or install-time side effects part
of the trust boundary.

## Evidence and Argument

- Strict lifecycle-disabled installs can leave missing executable projections.
- Prepared dependency artifacts deliberately exclude `.bin`, so projection must
  be recreated rather than archived as dependency data.
- pnpm's published linker remains useful as a compatibility oracle, but making
  it runtime authority would couple the stable DMP surface to pnpm internals and
  Node engine constraints.

## Options

| Option | Tradeoffs |
| --- | --- |
| effect-utils pure projector | Stable lifecycle-free authority with explicit compatibility responsibility. |
| pnpm linker as runtime authority | Maximum upstream behavior reuse but imports unstable internal/runtime coupling. |
| lifecycle-generated bins | Delegates behavior but violates the purity boundary. |

## Decision

Effect-utils owns the production bin projector.

The projector implements pure manifest-based linking over an already-realized
`node_modules` graph. It reads package manifests, resolves `bin` and
`directories.bin`, validates targets, creates profile-owned `.bin` entries, and
emits projection reports.

pnpm's published bin-linking packages are used as conformance oracles in tests,
not as the runtime authority.

## Consequences

- The implementation must cover pnpm-compatible bin edge cases intentionally
  rather than using an overly narrow string/object-bin shortcut.
- Native or generated CLI targets remain outside projection. They need a Nix
  native package integration or pure package artifact classification.
- pnpm linker package upgrades are test-oracle updates, not production behavior
  changes.
