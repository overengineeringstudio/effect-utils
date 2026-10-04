# FOD Hash Evidence Requirements

## Context

The prepared-install hash-repair producer contract is retired with its
[parent realization](../requirements.md).

## Requirements

DMP.NIX.FOD-R01 through DMP.NIX.FOD-R09 are retired identifiers reserved for
historical references. Current packages must not expose prepared-install hash
repair targets, direct restore derivations, or per-install-root hash registries.

This retirement does not remove immutable per-package archive hashes used by the
[Buck-to-Nix bridge](../../../builds/05-product-distribution/02-nix-bridge/spec.md). Those hashes identify
archive bytes, not normalized workspace install trees.
