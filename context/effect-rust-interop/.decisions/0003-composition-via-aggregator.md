# Decision: Composition via application aggregator

## Status

Status: accepted

## Context

Applications compose multiple engines but need to avoid duplicated runtime floors and shipping unused engines eagerly.

## Decision

Generate an application aggregator crate in Buck from the application manifest, uncommitted, with one wasm per eager or named lazy bundle group. Per-core Layers consume a shared WasmRuntime Layer within their group.

## Evidence and Argument

The [composition experiment](../.experiments/e1-composition.md) measured 21.3 versus 32.5 KB brotli, 12.8 versus 19.4 MB peak linear memory, and 9.2 versus 15.0 ms browser initialization for combined versus separate modules.

## Options

| Option                                             | Tradeoff                                             |
| -------------------------------------------------- | ---------------------------------------------------- |
| Buck-generated app aggregator per group (selected) | Deduplicates selected engines; build-time generation |
| Separate modules                                   | Independent loading, duplicated floors               |
| Universal all-core module                          | No app generation, unused engines shipped            |
| Committed generated crate                          | IDE visibility, freshness machinery                  |
| Nix-owned compiler                                 | Conflicts with Buck build authority                  |

Separate modules duplicate runtime/dependencies. A universal prebuilt all-core module ships unused cores. Committed generator output adds freshness machinery; a Nix-owned compiler path conflicts with Buck build ownership.

## Consequences

The shared wasm profile uses opt-level s, fat LTO, strip, and pinned wasm-opt -Oz/features, with runtime smoke and explicit product overrides. The exact measured size profile also used codegen-units=1; that setting is not mandated. Cross-group duplication buys lazy loading.

## Specification

[Application composition and build profile](../spec.md#application-composition-and-build-profile-r08-r09).

## Amendment 1

Application manifests list **adapter crates only**; Rust export signatures and expressions are not TypeScript strings. The [export attribute](./0008-idiomatic-boundary-api.md) owns build-time export metadata; Buck consumes it to generate bindings, service factories, and crate re-exports. The original eager/lazy group and shared-runtime decision remains intact. [K2](../.experiments/k2-build-admission.md) exercised eager and lazy products; the emitted package uses copied output rather than symlinks that resolve group imports against the source tree.
