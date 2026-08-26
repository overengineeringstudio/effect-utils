# Operation Roots and Overlay

## Status

Passed for the current repository corpus on 2026-08-12. Watch-mode invalidation
remains unproved.

## Question

Cargo-derived normal roots plus operation-local additive development roots give
useful precision without duplicating the manifest dependency map or adding a
generator lifecycle.

## Method

The two committed Rust manifests and lockfiles were measured as normal-only,
all-development, and selected-development closures. Direct use sites under
`packages/@overeng/otelite/tests` were inventoried. Separately, Bun imported a
Cargo TOML fixture through the existing package-local Genie evaluation path.

Recheck the direct-use inventory with:

```bash
rg -n 'proptest|reqwest|tempfile' packages/@overeng/otelite/tests --glob '*.rs'
```

## Result

| Crate         | Normal closure | All development closure | Marginal |
| ------------- | -------------: | ----------------------: | -------: |
| `otel-scrape` |             23 |                      32 |       +9 |
| `otelite`     |            118 |                     223 |     +105 |

For `otelite`, exact subsets produced 145 nodes with `tempfile`, 160 with
`proptest`, and 213 with `reqwest` plus `tempfile`. Its twelve integration-test
targets required twelve total alias entries: one uses `proptest`, three use
`reqwest`, and four use no direct development dependency. Bun imported the TOML
without a new parser dependency.

## Conclusion

Normal/platform roots are derived from Cargo authority. The overlay declares
only operation-specific additive roots, primarily development dependencies.
An explicit Cargo-development-scope superset may exist only as a separately
admitted migration policy. The overlay is a package-local typed module consumed
by the existing `BUCK.genie.ts` lifecycle; it is not Cargo metadata, Nix, or a
central package registry.

## VRS Impact

Resolves the baseline and lifecycle parts of `BUCK.GRAPH.BIND.RUST-DQ6` and
`BUCK.GRAPH.BIND.RUST-DQ7`. Exact API shape and watch freshness remain open.
