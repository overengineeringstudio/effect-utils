# Nix Prepared Dependencies Requirements

## Context

The workspace prepared-install packaging realization is retired. This node
records its retirement boundary, not an available builder API. Product packaging
is governed by the [Buck-to-Nix bridge](../../builds/05-product-distribution/02-nix-bridge/spec.md); live
installs remain governed by [live pnpm](../01-live-pnpm/requirements.md).

## Requirements

The former DMP.NIX-R01 through DMP.NIX-R13 identifiers are retired and reserved
for historical references. No consumer may require workspace prepared-install
FODs, their hash registry, restore metadata, source-support exports, or aggregate
manifest alignment passthrough from the current packaging surface.

Immutable per-package Buck archive acquisition is not a prepared-install
realization. Shared native dependency classification and audit remain active in
[02-native-node-packages](./02-native-node-packages/requirements.md).
