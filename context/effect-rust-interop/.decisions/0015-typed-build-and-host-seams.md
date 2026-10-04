# Decision: Typed build products and bounded host capabilities

## Status

Status: accepted

## Context

The content-address pilot exposed missing contract metadata, workspace emission, rustc resource inputs, backend feature authority, bounded reads, and generated-service package admission. Decisions q39–q43 retain the existing build authority instead of establishing product-local workarounds.

## Decision

- Rust output has a discriminated Cargo configuration: standalone or workspace member. Workspace mode inherits the selected workspace metadata/dependencies and does not emit a nested workspace. Required dependency features remain explicit.
- Declare compile-time resources through typed `compileTimeResources` in the Cargo-to-Buck package projection. They are rustc source inputs with crate-relative destinations and freshness/content tracking; reject traversal and destination collisions. They are not packaging-only assets or fake build-script inputs.
- Thin adapters default to both `wasm` and `napi` features, with backend dependencies target-gated. Product rules consume the admitted crate graph; a product label does not independently reconfigure already-compiled dependency features.
- Add typed `Source.read_range(path, offset, max)` with u64/bigint offsets, bounded owned responses, and explicit cooperative event-loop yielding between long CPU chunks. A cancellation-token check alone neither yields nor preempts a synchronous loop.
- Admit generated services through `typescriptPackage.generatedDependencies`, a typed generated-package product dependency pointing to the Buck service target. Do not substitute checked-in declarations, a second package authority, or a hidden synchronous/global backend facade.

## Evidence and Argument

[PR #1602](https://github.com/overengineeringstudio/effect-utils/pull/1602) exercises the content-address byte engine through generated contracts, scoped host callbacks, cancellation and quiescence. [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) owns the foundation and generated package boundary; [PR #1556](https://github.com/overengineeringstudio/effect-utils/pull/1556) owns the Buck products. These are open implementation PRs, not merged changes. Their dependency stack and verification blockers are not new build authorities.

## Options

| Option | Tradeoff |
| --- | --- |
| Typed projections and explicit range reads (selected) | One source/freshness authority; bounded memory and cooperative scheduling |
| Arbitrary Cargo template / metadata convention | Flexible, adds a second validation/ownership surface |
| Per-backend crate graphs | Exact feature selection, changes transitive graph authority |
| Whole-file reads plus Worker isolation | Simpler capability, does not bound file allocation |
| Checked-in generated declarations | Convenient editor input, freshness and artifact drift |

## Consequences

Compile-time resource edits must invalidate compilation, not merely final packaging. Target gates keep backend-specific dependencies out of the wrong target while both adapter features remain enabled by convention. Range reads require short-read/EOF and file-change semantics in the host contract; scheduling stays cooperative, not a CPU-preemption guarantee.

## Specification

[Application composition and build profile](../spec.md#application-composition-and-build-profile-r08-r09) and [runtime lifecycle](../spec.md#runtime-lifecycle-and-panic-containment-r10-r11-r15-r16).
