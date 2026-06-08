# Typed capability contexts (mirror Restate's context hierarchy in the type system)

The binding encodes Restate's context capabilities in Effect's type system rather
than exposing a single untyped context. Restate distinguishes `Context` (service)
/ `ObjectContext` / `ObjectSharedContext` / `WorkflowContext` /
`WorkflowSharedContext` to gate which operations are legal; the binding makes
those rules compile-time.

Mechanism (spec-level, may evolve): a `RestateContext` Tag holds the raw
per-invocation `restate.Context`, and **flat, independent capability-marker
services** in the `R` channel (`StateRead`, `StateWrite`, `DurablePromise`,
`ObjectKey`) are provided by each construct's handler builder. Durable
combinators carry the marker they need in `R` (e.g. `State.set` requires
`StateWrite`), so calling them where the marker isn't provided does not
typecheck — e.g. writing state in a shared/read-only handler, or resolving a
durable promise outside a Workflow `run`.

Markers are kept flat and independent — there is NO composite `WorkflowScope`
marker. Effect's `R` is intersection semantics, so a combinator that requires
`StateRead` is NOT satisfied by some umbrella marker that "contains" it; a
composite would not discharge the individual requirements. The Workflow `run`
boundary instead PROVIDES the concrete set `{ StateRead, StateWrite,
DurablePromise, ObjectKey }` directly. The markers gate the TYPE-LEGALITY of
operations, not their runtime ordering: single-writer-per-key serialization is
the `restate-server`'s job (A01), not something the marker types enforce.

`Restate.run` SCRUBS durable capabilities from its inner effect's `R`
(`Exclude<R, RestateContext | StateRead | StateWrite | DurablePromise |
ObjectKey | …>`), so a nested `ctx.*` / `State.get` / `Restate.sleep` inside a
`run` closure is a COMPILE error — mirroring Restate's own "no nested `ctx.*`
inside `run`" rule.

## Why

- A faithful binding should make Restate's illegal operations unrepresentable;
  this is where Effect's types earn their keep ("Restate the compiler
  understands").
- Mirrors Restate's own nominal context hierarchy without relying on Tag
  inheritance (which Effect `Context.Tag` does not model).

## Consequences

- More internal type machinery; the per-invocation `materialize` boundary must
  provide exactly the right capability markers per construct / handler kind.
- The authoring surface stays clean — users write capability-correct handlers and
  get compile errors on misuse.
- **Unproven**: the per-handler marker discharge at `materialize` over a
  HETEROGENEOUS handler record (an `implement` mixing exclusive and shared
  handlers) is not yet validated. The risk is that a `State.set` in a shared
  handler becomes a whole-record error or erases to `any` instead of a
  handler-LOCAL error. A Phase-1 type-level prototype gates this (prove the
  mixed-record case yields a handler-local error). Fallback if it cannot be made
  clean: distinct context Tags per handler kind (`ObjectExclusiveContext` vs
  `ObjectSharedContext`), matching the SDK's nominal split, instead of composing
  markers over one shared context.

Status: accepted

_Revised after design review: dropped the composite `WorkflowScope` marker
(intersection semantics make it non-discharging); added `Restate.run` capability
scrubbing and the Phase-1 heterogeneous-record discharge gate._
