# Projection Experiments

This file records non-normative projection evidence.

## Pure Install Versus Missing Bins

Hypothesis:

- Missing CLI bins after a strict `--ignore-scripts` install should be fixed by
  projection, not by permitting lifecycle scripts.

Result:

- Real downstream graphs exposed missing app-local bins after pure install.
  Enabling scripts restored the bins but also admitted lifecycle work, which is
  outside the effect-utils trust boundary.

Conclusion:

- Keep lifecycle scripts forbidden and add a pure manifest-based bin projector.

## Prepared FOD Bin Surface

Hypothesis:

- `.bin` entries in prepared dependency FODs are harmless metadata.

Result:

- Rejected. Removing `.bin` changed recursive prepared artifact hashes, so bin
  projection is a real fixed-output surface.

Conclusion:

- Prepared deps must strip and reject `.bin`, then recreate bins in the
  restore/build projection phase.

## Pnpm Linker Compatibility Probe

Hypothesis:

- Effect-utils can use pnpm's published bin linker directly as the long-term
  bin projection implementation.

Method:

- Inspected `@pnpm/bins.linker@1100.0.16` and `@pnpm/bins.resolver@1100.0.8`
  from npm.
- Built a throwaway fixture with scoped command names, dependency-directory
  aliases, `directories.bin`, and invalid path-like bin names.
- Ran `linkBins(..., { preferSymlinkedExecutables: true })` against the fixture.
- Ran a synthetic 1000-package benchmark comparing pnpm's linker to a simple
  serial manifest linker.

Results:

- `@pnpm/bins.linker` depends on pnpm manifest/workspace readers, pnpm logging,
  command-shim code, `bin-links`, and Node `>=22.13`.
- `@pnpm/bins.resolver` implements useful compatibility semantics:
  scope-stripping for command names like `@scope/tool`, `directories.bin`,
  path traversal rejection, URL-safe command-name filtering, and package-root
  containment checks.
- The fixture linked `@scope/tool` as `tool`, linked `directories.bin` files,
  ignored invalid path-like bin names, and did not execute package code.
- The 1000-package synthetic run was not performance-sensitive:
  pnpm linker took roughly 70-80 ms; the naive serial manifest linker took
  roughly 130-170 ms.

Conclusion:

- Performance does not justify avoiding pnpm's linker.
- Production should still be effect-utils-owned because dependency surface,
  engine coupling, and install-internal behavior are the relevant risks.
- pnpm's linker and resolver should be the conformance oracle for compatible
  edge cases.
