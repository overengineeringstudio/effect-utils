# Native Node Package Spec

This document specifies native Node package handling. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section        | Requirements                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| Classification | DMP.NIX.NATIVE-R01, DMP.NIX.NATIVE-R03, DMP.NIX.NATIVE-R05, DMP.NIX.NATIVE-R06 |
| Build Phase    | DMP.NIX.NATIVE-R02, DMP.NIX.NATIVE-R04, DMP.NIX.NATIVE-R07                     |

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
