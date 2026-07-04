# 0007 — Session/root state as a persisted open span (no daemon)

**Status:** Accepted.

**Context:** `otel-wrap root begin|end` (decision 0005) opens a root span in one
process invocation and closes it in another. Something must hold the open root
between them. Two shapes were available: a resident session daemon that keeps the
root open in memory, or a persisted representation on disk. The family already
has a content-addressed store (CAS) and a span model; the question is which
addressing model fits session/root state, and whether it can share the state-dir
with CAS.

**Decision:** Session/root state is a **persisted open span**: the same
`otel-core` span-model primitive, written to a `sessions/` store while still open,
so `begin` and `end` are separate stateless processes sharing only that file.
**No session daemon.**

The `sessions/` store lives under the one state-dir contract alongside `cas/`,
but with **distinct addressing semantics** — the reason they are two stores in
one container rather than one store:

- **CAS** is content-addressed: an object's identity is its content digest;
  objects are immutable and write-once.
- **sessions** is identity-addressed: an open span's identity is stable while its
  content (attributes, children, end time) changes; it is mutable and closed
  later.

Session/root state therefore reuses the **span model**, not CAS — a persisted
open span is the wrong shape for content-addressing (its content changes under a
stable identity, the opposite of a write-once digest). The persisted open span
_is_ the no-daemon realization: no resident process holds the root; the file is
the only shared state.

**Consequences:**

- The root/session bracket survives across process boundaries with no daemon,
  no socket, and no supervision.
- One state-dir holds both stores; a consumer reasons about `cas/` and
  `sessions/` as passive on-disk stores with different addressing, not one store.
- The span model is reused, not duplicated, for durable session state.
- Concurrency and cleanup of `sessions/` files follow the passive-store model
  (short-lived writers, no coordinator); the exact file lifecycle is
  [otel-wrap spec](../otel-wrap/spec.md) detail.
