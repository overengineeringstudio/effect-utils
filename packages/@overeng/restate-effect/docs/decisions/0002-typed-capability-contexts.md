# Typed capability contexts (mirror Restate's context hierarchy in the type system)

The binding encodes Restate's context capabilities in Effect's type system rather
than exposing a single untyped context. Restate distinguishes `Context` (service)
/ `ObjectContext` / `ObjectSharedContext` / `WorkflowContext` /
`WorkflowSharedContext` to gate which operations are legal; the binding makes
those rules compile-time.

Mechanism (spec-level, may evolve): a `RestateContext` Tag holds the raw
per-invocation `restate.Context`, and **capability-marker services** in the `R`
channel (e.g. `StateWrite`, `StateRead`, `WorkflowScope`, `ObjectKey`) are
provided by each construct's handler builder. Durable combinators carry the
capability they need in `R` (e.g. `State.set` requires `StateWrite`), so calling
them where the capability isn't provided does not typecheck — e.g. writing state
in a shared/read-only handler, or resolving a durable promise outside a Workflow
`run`.

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

Status: accepted
