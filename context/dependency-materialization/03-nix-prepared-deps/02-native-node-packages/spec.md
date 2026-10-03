# Native Node Package Spec

This document specifies shared native package policy. It builds on
[requirements.md](./requirements.md).

Status: **Active**

## Classification

```text
resolved lockfile -> shared family policy -> policy audit
product runtime   -> explicit platform inputs and wrappers
```

Traces: DMP.NIX.NATIVE-R01, DMP.NIX.NATIVE-R03, DMP.NIX.NATIVE-R06.

`genie/native-dependency-policy.ts` owns the shared family classifications;
`genie/ci-scripts/native-dep-policy-lib.ts` supports the policy audit.

| Classification           | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `nix-grafted`            | Native output is supplied by a Nix derivation or wrapper.          |
| `pure-package-artifact`  | Package contents are accepted as data without lifecycle execution. |
| `denied-lifecycle-build` | Package requires scripts/builds and is rejected until integrated.  |

Unclassified native families fail policy audit. Retiring a packaging realization
does not retire the shared registry or its audit coverage.

## Runtime Integration

Traces: DMP.NIX.NATIVE-R02, DMP.NIX.NATIVE-R07.

Platform-specific native outputs are explicit product inputs or runtime wrapper
inputs. Managed live installs do not execute lifecycle scripts to produce them.
Buck product imports validate the declared runtime boundary; see the
[Buck-to-Nix bridge](../../../buck2/06-nix-bridge/spec.md).

## Retired Realization

The prepared-install native-closure wrapper, optional-binding install-tree
capture, completeness engagement modes, and shared install-tree hash evidence
are retired. Historical decisions and experiments describe that former
realization, not an available current builder API.
