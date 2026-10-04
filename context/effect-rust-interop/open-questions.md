# Open questions: Effect–Rust interop foundation

These are the unresolved design/admission questions in the [active spec](./spec.md). Package identity, compiler choice, integer representations, local trap retirement, Buck products, annotation-first authoring, tag-order acceptance, browser assets, resources and direct transport are resolved in the [decision records](./.decisions/0001-tiered-delivery.md). The [epic](https://github.com/overengineeringstudio/effect-utils/issues/1549) and implementation PRs track integration; build bugs are not additional design questions.

| Question | Resolution evidence | Spec |
| --- | --- | --- |
| Neutral IDL | A language-neutral owner matching Effect Schema expressiveness, idiomatic runtime codegen and conformance. [#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547) remains parked; single-owner contracts do not wait for it. | [DQ6](./spec.md#design-questions) |
| Cloudflare production memory | Real Cloudflare resident peaks, memory-limit enforcement, recycling and repeated large-memory recovery. Local workerd delayed-GC evidence does not prove production admission. Evaluate pressure hints/budgets within that admission, not as selected defaults. | [DQ8](./spec.md#design-questions) |
| Cross-runtime Effect cohort | Compatibility/identity evidence across release cohorts and runtime boundaries. The implemented construction guard rejects a second physical Effect copy; dependency deduplication is the current contract, not a solution for arbitrary cross-copy execution. | [DQ10](./spec.md#design-questions) |
| Upstream asks | Feedback on the seven evidence-backed codec/Schema/AST asks and interest/collaboration questions in [Effect-TS/effect#8690](https://github.com/Effect-TS/effect/issues/8690). Repros ran on Effect 4.0.0; downstream compensations remain until public APIs or upstream decisions replace them. | [DQ11](./spec.md#design-questions) |
