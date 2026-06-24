# 0003 Native Policy Uses Pure Package Artifact

Status: **Accepted**

## Context

The native package VRS used `pure-package-artifact` for package contents that
may remain dependency data without lifecycle execution. The implementation used
`fod-accepted-prebuilt`, which tied the public classification to one current
realization: Nix fixed-output prepared dependencies.

## Decision

Use `pure-package-artifact` as the canonical native dependency policy tag.

Native package families are classified as:

| Tag                      | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `nix-grafted`            | Native output is supplied by Nix or an explicit wrapper.           |
| `pure-package-artifact`  | Package contents are accepted as data without lifecycle execution. |
| `denied-lifecycle-build` | Package requires scripts/builds and is rejected until integrated.  |

## Rationale

- The DMP contract spans live pnpm, Nix prepared deps, CI jobs, and Buck2
  evidence. A public tag should describe the dependency-materialization
  boundary, not only the fixed-output derivation mechanism.
- Current accepted prebuilts are still locked and scanned by prepared-deps
  policy; that mechanism belongs in the owning spec and implementation details.
- The term matches DMP-R04 and DMP.NIX.NATIVE-R03.

## Consequences

- Audit output now asks new gated native package families to be classified as
  `pure-package-artifact`, `nix-grafted`, or `denied-lifecycle-build`.
- Future non-FOD realizations, such as a Buck2 materialized package artifact or
  a read-only seed, can reuse the same classification if they satisfy the same
  purity requirements.
