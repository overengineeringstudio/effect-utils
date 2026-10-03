# FOD Hash Evidence Spec

This document specifies retirement of prepared-install hash evidence. It builds
on [requirements.md](./requirements.md).

Status: **Retired**

## Current Boundary

There is no prepared-install producer schema, package passthrough repair target,
covered-system install-tree measurement API, or source hash registry. Historical
measurements and decisions remain evidence of the retired realization.

Current immutable archive acquisition and product digest verification are owned
by the [Buck-to-Nix bridge](../../../buck2/06-nix-bridge/spec.md), not this node.
