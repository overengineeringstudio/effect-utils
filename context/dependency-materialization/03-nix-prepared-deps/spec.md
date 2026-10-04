# Nix Prepared Dependencies Spec

This document specifies the retirement boundary of the prepared-install
realization. It builds on [requirements.md](./requirements.md).

Status: **Retired**

## Current Boundary

Buck compiles products; Nix imports validated descriptors or reconstructs the
pinned Buck graph from declared source, capabilities, and immutable dependency
archives. See the [Buck-to-Nix bridge](../../builds/05-product-distribution/02-nix-bridge/spec.md).

There is no workspace pnpm installation, normalized prepared tree, downstream
restore, per-root prepared-output hash declaration, or prepared-builder support
export in this packaging path. Its compiler, native-closure wrapper, fixtures,
and hash-repair metadata contract are retired without compatibility aliases.

Live pnpm retains strict install policy, nested workspace boundaries, staged
source-input specifier algebra, and their live regression coverage. Shared native
policy and audits remain independent of the retired realization.

Decisions and experiments remain historical evidence, not current instructions.
