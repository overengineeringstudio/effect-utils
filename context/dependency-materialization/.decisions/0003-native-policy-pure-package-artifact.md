# 0003 Native Policy Uses Pure Package Artifact

Status: accepted

## Context

The native package VRS used `pure-package-artifact` for package contents that
may remain dependency data without lifecycle execution. The implementation used
`fod-accepted-prebuilt`, which tied the public classification to one current
realization: Nix fixed-output prepared dependencies.

## Evidence and Argument

- The public DMP contract spans live pnpm, Nix, CI, and future Buck2 evidence;
  `fod-accepted-prebuilt` incorrectly named one current realization.
- Current accepted prebuilts are still locked and scanned by prepared-deps
  policy, so the broader name does not weaken the purity gate.
- The term aligns with DMP-R04 and DMP.NIX.NATIVE-R03.

## Options

| Option | Tradeoffs |
| --- | --- |
| `pure-package-artifact` | Names the cross-realization property; requires specs to state each concrete proof. |
| `fod-accepted-prebuilt` | Mechanically precise today but leaks Nix FOD realization into the public ontology. |
| one generic native exception | Simpler vocabulary but erases the purity/build distinction. |

## Decision

Use `pure-package-artifact` as the canonical native dependency policy tag.

Native package families are classified as:

| Tag                      | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `nix-grafted`            | Native output is supplied by Nix or an explicit wrapper.           |
| `pure-package-artifact`  | Package contents are accepted as data without lifecycle execution. |
| `denied-lifecycle-build` | Package requires scripts/builds and is rejected until integrated.  |

## Consequences

- Audit output now asks new gated native package families to be classified as
  `pure-package-artifact`, `nix-grafted`, or `denied-lifecycle-build`.
- Future non-FOD realizations, such as a Buck2 materialized package artifact or
  a read-only seed, can reuse the same classification if they satisfy the same
  purity requirements.
