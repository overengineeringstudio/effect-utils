# Native Node Package Spec

This document specifies native Node package handling. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section              | Requirements                                                                   |
| -------------------- | ------------------------------------------------------------------------------ |
| Classification       | DMP.NIX.NATIVE-R01, DMP.NIX.NATIVE-R03, DMP.NIX.NATIVE-R05, DMP.NIX.NATIVE-R06 |
| Build Phase          | DMP.NIX.NATIVE-R02, DMP.NIX.NATIVE-R04, DMP.NIX.NATIVE-R07                     |
| Closure Completeness | DMP.NIX.NATIVE-R08, DMP.NIX.NATIVE-R09, DMP.NIX.NATIVE-R10, DMP.NIX.NATIVE-R11 |

## Classification

Native package families use one of these classifications:

| Classification           | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `nix-grafted`            | Native output is supplied by a Nix derivation or wrapper.          |
| `pure-package-artifact`  | Package contents are accepted as data without lifecycle execution. |
| `denied-lifecycle-build` | Package requires scripts/builds and is rejected until integrated.  |

Prepared-deps scans apply the classification before accepting `*.node` files or
known platform package directories.

## Build Phase

Nix grafts happen during the platform-specific downstream build or wrapper
phase, where the target system is already part of ordinary Nix package
identity.

The platform-neutral prepared dependency artifact must not depend on optional
npm packages or install hooks to select native outputs.

## Closure Completeness

Traces: DMP.NIX.NATIVE-R08, DMP.NIX.NATIVE-R09, DMP.NIX.NATIVE-R10,
DMP.NIX.NATIVE-R11.

Classification (above) decides _whether_ a native family may live in dependency
data. Completeness decides _whether the family that does live there is whole_.
They are two directions of one scan over the prepared `.pnpm` tree:

| Direction    | Guarantee                                    | Requirement            |
| ------------ | -------------------------------------------- | ---------------------- |
| Rejection    | No _unexpected / unclassified_ native output | DMP.NIX.NATIVE-R04/R05 |
| Completeness | Every _declared_ family binding is _present_ | DMP.NIX.NATIVE-R08     |

Enabling the opt-in surfaces native dirs (0 → many `.node` files across platform
dirs) that are governed by this same scan and the same classification (`0004`
v18): an unclassified family fails per `DMP.NIX.NATIVE-R06` (classify-or-fail),
a classified `pure-package-artifact` family must be complete per
`DMP.NIX.NATIVE-R08`. There is no "R08 requires it but R05 rejects it" gap —
rejection and completeness are the two directions of one scan over one
classification, not two competing scans.

### Detector — auto-derive the required family set

The detector reads the root's resolved lockfile closure (dev + prod) and
computes the required set with no hand-maintained list (`DMP.NIX.NATIVE-R09`):

1. Enumerate packages classified `pure-package-artifact` (reusing the native
   dependency policy — one registry, not a fork; see `0003`).
2. For each such family, read its declared optional binding packages and expand
   `supportedArchitectures` into concrete `(os, cpu, libc)` triples.
3. The required set is `{ family × declared triple }`.

Over-approximation is deliberate and in the safe direction: a family present in
the closure but not actually loaded at build time (e.g. a CSS transformer behind
an unused code path) is still required to be complete. Presence-in-closure is
cheap to satisfy — pnpm optional install is per-root all-or-nothing — and
missing a _loaded_ binding is the failure this prevents. A family with no
prebuilt for a declared triple is handled by an explicit waiver, not by dropping
it from the required set.

### Completeness mode

| Mode                             | Required coverage                      | Hash consequence                          |
| -------------------------------- | -------------------------------------- | ----------------------------------------- |
| `all-declared-triples` (default) | every declared `(os,cpu,libc)` triple  | host-invariant → single shared hash sound |
| `build-platform`                 | only an explicit `buildPlatformTriple` | host-variant → per-system hash fallback   |

`all-declared-triples` is the default because it is the precondition for a sound
shared FOD hash (see `01-fod-hash-evidence` and `0008`, `0009`).

### Assertion and engagement

For every required `{ family × triple }`, assert the binding package directory is
present in the captured `.pnpm` tree. On a miss, fail naming `family + missing
triple(s)` (`DMP.NIX.NATIVE-R10`) — the diagnostic points at the prepared
artifact, not at a downstream runtime resolution error.

Engagement is a function of the root's opt-in (`DMP.NIX-R11`), not a
report-only phase (consistent with `0004`):

| Root state                                  | Completeness assertion                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| opts into optional bindings (`DMP.NIX-R11`) | hard fail on a miss                                     |
| does not opt in                             | advisory only (families are not required for that root) |

An opt-in root is enforced strictly from the first build — there is no lenient
mode running beside the strict one for the same boundary. See `0009` for how a
future default-on expansion is sequenced as a versioned transition rather than a
lenient legacy phase.

### Waivers and tripwire

- **Waiver** (`DMP.NIX.NATIVE-R11`): the only explicit per-root input beyond the
  opt-in. Reason-carrying; scoped to the named family/triple; must not expand to
  unnamed families.
- **Expected-set tripwire** (optional defense-in-depth): an opt-in root may pin
  the expected derived family set so a dependency bump that silently _adds_ a
  native family fails until reviewed. Off by default; auto-derive stays
  authoritative.
