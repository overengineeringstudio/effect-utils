/**
 * State/action/reducer for the `sync --watch` live human view (the
 * `/sk-cli-design` `app/schema/view` triple, mirroring `sync`/`edit`).
 *
 * `--watch` runs an INFINITE loop of reconcile passes — there is no terminal
 * state. The single `Watching` tag accumulates, across passes:
 *
 * - **counters** — running tallies per normalized outcome (`pushed`/`pulled`/
 *   `noop`/`conflict`/`error`), bumped by every pass (single-file and batch
 *   share the same map so the summary line reads uniformly).
 * - **lastResult** — the most recent pass label + reason, drives the live
 *   StatusGlyph (ok vs error/conflict).
 * - **recentEvents** — a ring buffer (≤5, newest LAST internally) of one line
 *   per pass for the `events(N):` detail section.
 *
 * IMPORTANT: this seam renders the live view ONLY in react (TTY) output. The
 * machine modes (`json`/`ndjson`) bypass it entirely and run the existing
 * `runWatch`/`runBatchWatch` `writeJsonLine` stream verbatim, so this schema
 * can never threaten the per-pass ndjson byte-identity (see `cli-program.ts`
 * `runWatchOutput`). Design the action purely for the view.
 *
 * @module
 */

import { Schema } from 'effect'

/** Why a watch pass fired (mirrors the engine's `WatchReason`, plus `batch`). */
export const WatchReason = Schema.Literal('file', 'initial', 'poll', 'batch')
export type WatchReason = typeof WatchReason.Type

/**
 * Normalized per-pass / per-page outcome buckets that drive the counters map
 * and the summary line. `conflict` is SYNTHESIZED from an `NmdConflictError`
 * (there is no `conflict` engine result tag); `error` covers genuine failures.
 */
export const WatchOutcome = Schema.Literal('pushed', 'pulled', 'noop', 'conflict', 'error')
export type WatchOutcome = typeof WatchOutcome.Type

/** Running tallies per outcome (every counted pass bumps exactly one bucket per page). */
export const WatchCounters = Schema.Struct({
  pushed: Schema.Number,
  pulled: Schema.Number,
  noop: Schema.Number,
  conflict: Schema.Number,
  error: Schema.Number,
})
export type WatchCounters = typeof WatchCounters.Type

/**
 * The outcome of a single pass, normalized for the view.
 *
 * - `Single` — a one-file pass resolved to a single outcome.
 * - `Batch` — a multi-file pass; `outcomes` is the per-page bucket list so the
 *   reducer can bump the shared counters once per page.
 * - `Failure` — the whole pass failed (network, missing file, …); `message`
 *   surfaces as a WARNING and bumps the `error` counter.
 */
export const WatchPassResult = Schema.Union(
  Schema.TaggedStruct('Single', { outcome: WatchOutcome }),
  Schema.TaggedStruct('Batch', { outcomes: Schema.Array(WatchOutcome) }),
  Schema.TaggedStruct('Failure', { message: Schema.String }),
)
export type WatchPassResult = typeof WatchPassResult.Type

/** One entry in the recent-events ring (a single rendered line per pass). */
export const WatchEvent = Schema.Struct({
  /** Why the pass fired. */
  reason: WatchReason,
  /** Short outcome label (e.g. `pushed`, `3 pushed · 1 conflict`, `error`). */
  label: Schema.String,
  /** True when the pass errored or conflicted (drives the WARNING surfacing). */
  problem: Schema.Boolean,
})
export type WatchEvent = typeof WatchEvent.Type

/** Most recent pass summary — drives the live StatusGlyph + `last:` status line. */
export const WatchLastResult = Schema.Struct({
  reason: WatchReason,
  label: Schema.String,
  /** True when the last pass errored/conflicted (StatusGlyph → error). */
  problem: Schema.Boolean,
  /** Optional conflict/failure detail surfaced as a WARNING problem. */
  detail: Schema.optional(Schema.String),
})
export type WatchLastResult = typeof WatchLastResult.Type

/** Max recent-event ring entries retained (older entries drop). */
export const WATCH_RING_SIZE = 5

/**
 * `sync --watch` UI state. A single non-terminal `Watching` tag: watch never
 * "finishes", so unlike `sync`/`edit` there is no `Success`/`Error` variant.
 */
export const WatchState = Schema.TaggedStruct('Watching', {
  /** Watch target label (file path or tree/batch descriptor). */
  target: Schema.String,
  /** Poll interval in ms (shown in the status line); 0 until seeded. */
  pollIntervalMs: Schema.Number,
  /** `true` once the watch loop has run at least one pass. */
  active: Schema.Boolean,
  counters: WatchCounters,
  lastResult: Schema.optional(WatchLastResult),
  /** Recent passes, oldest-first internally (the view reverses to newest-first). */
  recentEvents: Schema.Array(WatchEvent),
})
export type WatchState = typeof WatchState.Type

/** Actions the watch program dispatches (seed + one pass per reconcile). */
export const WatchAction = Schema.Union(
  /** Seed the real target + poll interval (the cached app starts empty). */
  Schema.TaggedStruct('Init', { target: Schema.String, pollIntervalMs: Schema.Number }),
  /** Update the target label without resetting counters. */
  Schema.TaggedStruct('SetTarget', { target: Schema.String }),
  /** One reconcile pass (single-file, batch, or whole-pass failure). */
  Schema.TaggedStruct('WatchPass', {
    reason: WatchReason,
    result: WatchPassResult,
    /** Optional conflict/failure detail to surface as a WARNING. */
    detail: Schema.optional(Schema.String),
  }),
)
export type WatchAction = typeof WatchAction.Type

const ZERO_COUNTERS: WatchCounters = { pushed: 0, pulled: 0, noop: 0, conflict: 0, error: 0 }

/** Initial state for a `sync <target> --watch` run (before the first pass). */
export const initialWatchState = (target: string): WatchState => ({
  _tag: 'Watching',
  target,
  pollIntervalMs: 0,
  active: false,
  counters: ZERO_COUNTERS,
  lastResult: undefined,
  recentEvents: [],
})

/** Bump the counter buckets for one pass's outcomes. */
const bumpCounters = ({
  counters,
  outcomes,
}: {
  readonly counters: WatchCounters
  readonly outcomes: readonly WatchOutcome[]
}): WatchCounters => {
  const next = { ...counters }
  for (const outcome of outcomes) next[outcome] = next[outcome] + 1
  return next
}

/** Append a ring entry, dropping the oldest past {@link WATCH_RING_SIZE}. */
const pushRing = ({
  ring,
  entry,
}: {
  readonly ring: readonly WatchEvent[]
  readonly entry: WatchEvent
}): readonly WatchEvent[] => {
  const next = [...ring, entry]
  return next.length > WATCH_RING_SIZE ? next.slice(next.length - WATCH_RING_SIZE) : next
}

/** Per-pass outcome list (one bucket per page; a whole-pass failure is one `error`). */
const passOutcomes = (result: WatchPassResult): readonly WatchOutcome[] => {
  switch (result._tag) {
    case 'Single':
      return [result.outcome]
    case 'Batch':
      return result.outcomes
    case 'Failure':
      return ['error']
  }
}

/** Short label for a pass's outcome (single bucket, batch counts, or `error`). */
const passLabel = (result: WatchPassResult): string => {
  switch (result._tag) {
    case 'Single':
      return result.outcome
    case 'Batch': {
      const counts = new Map<WatchOutcome, number>()
      for (const outcome of result.outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
      const parts = [...counts.entries()].map(([outcome, n]) => `${n} ${outcome}`)
      return parts.length === 0 ? 'no files' : parts.join(' · ')
    }
    case 'Failure':
      return 'error'
  }
}

/** True when a pass should surface as a problem (errored or any page conflicted). */
const passHasProblem = (result: WatchPassResult): boolean => {
  switch (result._tag) {
    case 'Single':
      return result.outcome === 'conflict' || result.outcome === 'error'
    case 'Batch':
      return result.outcomes.some((outcome) => outcome === 'conflict' || outcome === 'error')
    case 'Failure':
      return true
  }
}

/** Fold a {@link WatchAction} onto the current {@link WatchState}. */
export const watchReducer = ({
  state,
  action,
}: {
  state: WatchState
  action: WatchAction
}): WatchState => {
  switch (action._tag) {
    case 'Init':
      return { ...state, target: action.target, pollIntervalMs: action.pollIntervalMs }
    case 'SetTarget':
      return { ...state, target: action.target }
    case 'WatchPass': {
      const outcomes = passOutcomes(action.result)
      const label = passLabel(action.result)
      const problem = passHasProblem(action.result)
      return {
        ...state,
        active: true,
        counters: bumpCounters({ counters: state.counters, outcomes }),
        lastResult: {
          reason: action.reason,
          label,
          problem,
          ...(action.detail === undefined ? {} : { detail: action.detail }),
        },
        recentEvents: pushRing({
          ring: state.recentEvents,
          entry: { reason: action.reason, label, problem },
        }),
      }
    }
  }
}

/**
 * In-app exit-code view. Watch is infinite and only ends via interrupt (Ctrl+C);
 * the real exit code is owned by `runMain` teardown. A live conflict/error is a
 * reported per-pass outcome, not a fatal state, so steady-state stays exit 0.
 */
export const watchExitCode = (_state: WatchState): number => 0
