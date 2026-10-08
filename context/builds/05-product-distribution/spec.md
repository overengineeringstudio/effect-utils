# Product Distribution Spec

This document specifies the distribution composition. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Owns product and import composition, not deployment or cache authorization.

## Boundary

```text
producer -> descriptor + payload -> independent expectation -> Nix import
```

The [product contract](./01-product-contract/spec.md) binds bytes and runtime
compatibility. The [Nix bridge](./02-nix-bridge/spec.md) validates them, substitutes
immutable results and rebuilds from the same pinned graph on a miss.
Component stamps follow [identity](../01-identity/spec.md); deployment identity
does not enter product action keys (BUILD.DIST-R01).
