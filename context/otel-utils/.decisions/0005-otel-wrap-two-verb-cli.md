# 0005 — otel-wrap CLI: two verbs

**Status:** Accepted.

**Context:** The universal wrap + root/session floor must cover two distinct
shapes: wrapping a single command (root-or-join around one child, the successor
to `otel-run` and `otel-span run`) and bracketing a longer-lived root/session
across multiple process invocations (the successor to a spool-based session
open/close). A large verb surface would blur `otel-wrap` with `otel-scrape`
(which owns adapters) and tempt a standalone emit-span verb.

**Decision:** `otel-wrap` has exactly two verbs:

- **`otel-wrap [--root|--join|--attr k=v] -- <cmd>`** — wrap one command.
  Composes the wrap primitive + mint/join precedence: `--join` forces join of an
  inbound `traceparent`, `--root` forces a fresh root, absent flags follow the
  mint/join precedence; `--attr k=v` adds attributes to the command span. This is
  the task-layer floor: `otel-wrap --attr task.name=… -- <task-body>`.
- **`otel-wrap root begin|end`** — stateless open/close of a persisted root span.
  `begin` mints (or joins) a root and persists it as an open span in the
  `sessions/` store; `end` closes it. The two invocations share only the
  `sessions/` file (decision 0007) — no resident process.

`otel-wrap` has **no standalone emit-span verb.** Emitting a structured span from
tool output is an adapter concern owned by `otel-scrape` (requirement R03). This
keeps the floor minimal and the role boundary clean.

**Consequences:**

- `otel-run` and `otel-span run` are subsumed by the command verb; the standalone
  `otel-span` emit path is dropped, its capability moving to adapters.
- The root/session bracket is a stateless process pair, aligning with the
  no-daemon state model (decision 0007).
- Both verbs consume the shared mint/join precedence, so `otel-wrap`'s root
  behavior is the same rule `otel-scrape` uses (requirement R14), not a divergent
  copy.
