# 0023 Rust Workspace Before Product Proof

Status: accepted

## Context

The authoritative five-member Cargo workspace and strict whole-workspace Reindeer dependency graph are admitted. Phase 5 still needs first-party Buck compilation, real otelite and otel-scrape BuildProducts, independent Nix imports, and eventual deletion of superseded Cargo/Nix producers. The roadmap did not fix the order or the boundary between proof and deletion.

## Evidence and Argument

The strict Reindeer baseline established one shared selected dependency topology and rejected a byte-identical members-only lock projection. Repository inspection found otel-scrape to be the smaller product closure, but compile-rule defects can affect any of the five workspace members. Existing Cargo/Nix producers remain executable comparison oracles until both replacement product paths have retained parity evidence.

Johannes resolved three structured questions on 2026-08-30: admit compile rules for all five members before product proof; prove the larger otelite application before otel-scrape; and retain existing producers through both independent import proofs before a separate removal change.

## Options

| Decision | Selected | Alternative rejected |
| --- | --- | --- |
| Compilation scope | All five workspace members before product proof | One otel-scrape vertical canary |
| Product order | OTelite, then otel-scrape | OTel-scrape, then otelite |
| Removal boundary | Retained parity checkpoint, then focused removal | Delete producers in the admission scope |

## Decision

Phase 5 first admits Buck compilation for otelite, otel-scrape, archive-tool, core, and product against the one strict Reindeer graph. After all five compile, otelite emits the first strict `buck-build-product/v1` descriptor and payload and passes independent Nix import. OTel-scrape then passes the same product and import boundary.

The existing Cargo/Nix producers remain intact throughout admission and both product proofs. Their outputs are comparison oracles. Superseded producers are deleted only in a subsequent focused change backed by retained two-product parity and invalidation evidence.

## Consequences

- First-party Rust rule design must cover the complete workspace before product packaging is accepted.
- OTelite carries the first product-contract debugging cost despite its larger application surface.
- Product admission remains ordered: an otelite proof does not implicitly admit otel-scrape.
- Phase 5 has an explicit dual-running checkpoint before authority deletion.
- Producer removal is independently reviewable and reversible; it is not bundled into replacement proof.
