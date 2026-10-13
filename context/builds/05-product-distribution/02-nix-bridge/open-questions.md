# Nix Bridge Open Questions

## Open 2026-09-19: Cachix retention and the R2 exit

Pins are GC-immune and revisioned; the publisher must name pins by digest and never re-point. Unknown: retention at our volume (92 historical releases; ~20 products) and the criteria that trigger the native S3/R2 binary cache. Blocked on: first month of cache-publisher operation.

## DQ1: Action-level reuse across changed-closure product builds

Linked spec: [DQ1](./spec.md#open-design-questions). Evidence:
[InNixReuse experiment](./.experiments/2026-10-05-action-level-innix-reuse.md).

**Current answer:** Johannes chose `keep-pure-record` in q29 (request `xwrtkk`,
answer `n073ei`): keep pure sandboxed Nix product builds and record the evidence.
This leaves [0037](../../.decisions/0037-nix-substitution-is-the-distribution-layer.md)
unchanged. The open research question is when changed-closure rebuild economics
justify action-level reuse, not whether Nix substitution remains distribution.

**Revisit trigger:** the daily cache-health mission shows changed-product
rebuild cost dominating. Evaluate measured changed-product build wall cost
against unchanged-product substitution and false-touch invalidation cost; do
not infer it from shared REAPI hit rate. In-Nix evidence is
`remote-cache-disabled-by-design`, not a zero-hit regression
([reuse evidence contract](../../04-buck2/06-reuse-client/spec.md#ci-cache-evidence-artifacts)).
No numerical dominance threshold is prescribed by the answer.

| Non-chosen alternative                                                      | What would resolve it                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E: Slim offline dependency-only REAPI capsules inside the sandbox           | Prove a stable graph-derived, reconstructible and substituted capsule with worthwhile end-to-end savings after transport/materialization, bounded size/retention, compatibility checks and cold failure fallback. Darwin transport is a separate unproved boundary. |
| D: Amend 0037 for protected direct-Buck publication plus verified CA import | Explicitly decide the publisher trust-model change and design audited hermetic execution, protected publication, verified CA registry identity, same-graph sandbox reconstruction and digest equality. The direct smoke is not that authorization.                  |

False-touch reduction precedes new machinery: merged closure precision
[#4743](https://github.com/schickling/dotfiles/pull/4743) and dependency
projections [#4760](https://github.com/schickling/dotfiles/pull/4760) reduce the
frozen top-ten replay **604 → 554 → 462**; pending telemetry cutover
[#4798](https://github.com/schickling/dotfiles/pull/4798) reports **462 → 371**.
These are touch opportunities in an eight-date weekly-window replay, not
observed builds/week; the experiment records the method and normalization.
