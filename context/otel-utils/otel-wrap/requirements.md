# Requirements: otel-wrap

`otel-wrap` is the universal wrap + root/session bin of the `otel-utils` family:
the always-available floor that roots or joins a trace and brackets a
root/session, deployable in agent bash, CI, and plain shells. Role and
composition are set by the family docs — [../vision.draft.md](../vision.draft.md),
[../requirements.md](../requirements.md), [../spec.md](../spec.md). This subsystem
carries no vision; it refines the family requirements for the floor bin.

R-IDs are local to this document (they restart at R01); cross-document references
name the subsystem (e.g. "otel-wrap R01").

## Context

- Refines [../requirements.md](../requirements.md) R03 (role boundaries), R04–R06
  (universal root model), and R13 (state-dir) for the floor bin.
- Composes [../otel-core/requirements.md](../otel-core/requirements.md) primitives
  (wrap primitive, mint/join precedence, span model, state-dir, trace-url
  surfacing); it re-implements none of them.
- The two-verb CLI is [../.decisions/0005-otel-wrap-two-verb-cli.md](../.decisions/0005-otel-wrap-two-verb-cli.md);
  the root model is [../.decisions/0006-universal-root-model.md](../.decisions/0006-universal-root-model.md);
  session state is [../.decisions/0007-session-root-state-persisted-open-span.md](../.decisions/0007-session-root-state-persisted-open-span.md).
- Supersedes the legacy `otel-run` and `otel-span run` (task-layer spans + root
  minting; spool-based). It is **not** blocked on native devenv OTLP.

## Assumptions

- **A01 Thin composition:** `otel-wrap` owns only its CLI surface and composes
  `otel-core` primitives; it holds no exporter, span model, or context handling
  of its own.
- **A02 Floor, not override:** Where a principled native OTEL root exists,
  `otel-wrap` joins it; the floor exists for workloads that lack one.

## Acceptable Tradeoffs

- **T01 Two verbs only:** A deliberately minimal verb surface (command wrap +
  `root begin|end`) trades feature breadth for a clean role boundary against
  `otel-scrape`'s adapters and the dropped standalone emit-span path.

## Requirements

### CLI surface

- **R01 Command verb:** `otel-wrap [--root|--join|--attr k=v] -- <cmd>` wraps one
  command, composing the wrap primitive and mint/join precedence. `--join` forces
  join of an inbound `traceparent`; `--root` forces a fresh root; absent flags
  follow the precedence; `--attr k=v` adds attributes to the command span. This is
  the task-layer floor (`otel-wrap --attr task.name=… -- <task-body>`).
- **R02 Root/session verb:** `otel-wrap root begin|end` statelessly opens and
  closes a persisted root span. `begin` mints or joins a root and persists it as
  an open span in `sessions/`; `end` closes it. The two invocations share only
  the `sessions/` file.
- **R03 No emit-span verb:** `otel-wrap` has no standalone span-emit verb; emitting
  a structured span from tool output is an adapter concern owned by `otel-scrape`
  (family requirement R03).

### Behavior

- **R04 Mint-or-join precedence:** `otel-wrap` follows the single `otel-core`
  mint/join precedence (join ambient `traceparent`; else mint), so its root
  behavior is the same rule `otel-scrape` uses, not a divergent copy.
- **R05 Passthrough + disabled transparency:** The command verb preserves the
  child's stdout/stderr/exit and, with no telemetry configured, is
  indistinguishable from direct execution (inherited from the `otel-core` wrap
  primitive).
- **R06 Trace-url surfacing on root-mint:** When `otel-wrap` mints the root (no
  inbound `traceparent`) and telemetry is active, it surfaces the trace id/URL
  terminal-only (stderr), via the `otel-core` surfacing primitive; a joined run
  stays silent so exactly one participant surfaces per trace.

### Root/session state

- **R07 Persisted open span:** Root/session state is a persisted open span in the
  shared state-dir `sessions/` store (reusing the `otel-core` span model), not
  CAS and not a daemon.
- **R08 Public-safe:** Every `otel-wrap` sink is public-safe by default via the
  `otel-core` trust-gate; raw argv/cwd/local paths are trust-gated, secrets never
  emit.

### Replacement of legacy tools

- **R09 Subsumes otel-run + otel-span run:** The command verb replaces `otel-run`
  and `otel-span run`. The migration replaces those tools rather than moving
  them, and is not gated on native devenv tracing (which becomes a later optional
  upgrade under the universal root model).
