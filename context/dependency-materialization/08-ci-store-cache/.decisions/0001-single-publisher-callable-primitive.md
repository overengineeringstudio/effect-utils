# 0001 Single Publisher Is A Callable Primitive, Not An Inherited Default

Status: accepted

## Context

Uncoordinated saves of the CI pnpm store on shared self-hosted runners exhaust
disk, and a cache no job saves never warms (`DMP.CICACHE-R03`). The obvious fix
is to make single-writer a default behavior of the shared setup/save steps. But
consumers do not compose their jobs through one shared composer — each hand-rolls
its own job factory and calls the save step directly.

## Decision

Express single-writer as callable primitives that hand-rolled factories adopt,
not as a default they inherit:

- a per-job publisher gate that appends the save step only when the job is the
  designated publisher;
- a workflow-level stamper that appends the save to exactly one named job and
  throws if that job is absent or if any job already saves.

## Rationale

- A default cannot converge state it does not own: since the factories bypass the
  shared composer and call save directly, an inherited default would not reach
  them. A callable primitive meets the code where it actually is.
- Fail-closed beats convention. The stamper turns "exactly one writer" from a
  reviewer's responsibility into a build-time error on zero or many.

## Consequences

- Each consumer designates one publisher job and routes its save through the
  primitive; N-publisher (cloud matrices) sets the gate on several jobs
  deliberately.
- The shared self-hosted post-step helper delegates to the primitive so aligned
  and future repos get the correct default for free.
- Jobs expressed as reusable-workflow `uses:` cannot be stamped in place and use
  the per-job gate.
- Residual divergence is the hand-rolled factories themselves; converging them
  onto one shared composer is tracked as a follow-on (spec DQ1).
