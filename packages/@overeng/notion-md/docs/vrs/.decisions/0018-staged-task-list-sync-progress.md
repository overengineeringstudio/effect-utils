# Sync progress is a staged `TaskList`, not a fake percentage

When a write-path command (`edit` save, `put`, file `sync`) runs, the sync makes
several remote round-trips with no UI in between, so it reads as a hang. The
remedy is a **discrete-stage progress indicator** rendered as
`@overeng/tui-react`'s `TaskList` — one checklist row per named sync stage
(observe → write-body → write-title → settle), each row carrying a status
(`pending` / `active` spinner / `success` / `error` / `skipped`) plus an
`X/total · elapsed` summary — driven by stage events the engine emits to a
`ProgressReporter` service.

It is **not** a smooth `%` / data progress bar.

## Why

There is no per-block progress data to drive a percentage. The body write
(`replace_content`) is one opaque server-side call, and the block-tree pull
discovers children by a recursive crawl whose total is unknown until it finishes.
A `%` bar would have to invent a denominator — a fake, jittery number that erodes
trust the moment a stage stalls. Discrete named stages are the honest shape: the
user sees _which_ step is running and that it is still moving (the spinner), which
is exactly the "is it hung?" question being answered.

The four near-identical remote pulls the engine already performs (status pull,
pre-push re-read, post-write re-observe, …) read as one indistinguishable hang
unless they are labelled. Emitting **purpose-tagged** stage events lets the same
mechanical pull surface as a distinct human stage ("observe", "settle", …)
without the engine knowing anything about rendering. The complementary perf lever
— collapsing those redundant pulls — is tracked separately (#788); this decision
makes the existing passes legible, it does not change how many there are.

## Mechanism

- A `ProgressReporter` service (`Context.Tag`) with a **no-op default `Layer`**.
  The engine emits purpose-tagged stage events to it; in every non-interactive
  context the events fall on the floor with zero rendering cost and no behavior
  change. The CLI provides a `TaskList`-backed `Layer` only on the write path.
- Rendered through the TUI render seam to **stderr**, gated on
  `process.stderr.isTTY`. `cat`'s **stdout stays pure Markdown** (decision 0002)
  so `notion-md cat … | put` and `… | put > file` keep working; when stderr is not
  a TTY the reporter degrades to the no-op (or a terse static line), never animated
  control sequences in a pipe or log.
- The CLI `TaskList` app is constructed **lazily inside the command handler**, not
  at module top level. notion-md has no runtime TUI import today; a top-level
  `createTuiApp(...)` would re-enter the same concurrent-module-load TDZ that
  crashed the umbrella in #787 (`createTuiApp` reached while
  `@overeng/tui-react` was mid-initialization). A lazy, memoized accessor inside
  the handler keeps the TUI graph out of import-time evaluation.
- **Scope: the write path only** (`edit` save, `put`, file `sync`). `cat` is a
  read pipe and is excluded — it must stay a clean stdout producer with nothing on
  stderr but its existing `base-hash:` line.

## Consequences

- The engine depends on `ProgressReporter` but stays render-agnostic: it emits
  tagged stage transitions, the Layer decides whether/how to render. Pure planning
  code is unaffected.
- Because the default Layer is a no-op, fake-gateway and live E2E suites that drive
  the engine without a TUI need no change; only the CLI write path wires the
  `TaskList` Layer.
- The stage vocabulary (observe / write-body / write-title / settle) is a CLI-facing
  presentation contract, distinct from the OTEL span names (which stay on the
  `notion_md.*` namespace). A stage may map to several spans or none.
- `put`'s two non-atomic writes (body, then title — decision 0012) surface as two
  rows, so a partial write (exit 10) is visibly the title row failing after the
  body row succeeded, rather than an opaque failure.

## Status

accepted (composes with 0002 stderr/stdout split, 0012 two-write order, 0017
engine reuse; complementary to redundant-pull collapse #788)
