/**
 * syncStory.ts — the declarative step-model for the recurring causal shape
 * "edit → local effect → sync → remote effect" (duplication axis F).
 *
 * WHAT IT GUARANTEES (the load-bearing invention, decision #3):
 * constructing a story ASSERTS cause-before-effect. A causally inverted story
 * (remote effect before the sync, sync before the local edit, an effect at the
 * same instant as its cause) THROWS at build time — `render.ts` exits non-zero
 * and NO html is written. A causal inversion cannot ship.
 *
 * TIMELINE MODEL. The engine advances integer steps, but the newest causal
 * gates fire effects at an intra-step `animation-delay` (the SQLite cell flips
 * ~1.35s into step 2 when the typewriter finishes; Notion flips ~1.45s into
 * step 3 when the sync packet lands). So an event is a point on a 2-D timeline
 * `{ step, delay }`, compared lexicographically. This lets the assert catch the
 * dominant "effect-before-cause" bug class the causality review catalogued
 * (effect at t=0 of the right step, while its cause is still running).
 *
 * The engine + kit CSS remain ground truth: this model emits the reveal-class
 * hooks the verbatim CSS already consumes (`only-1`, `r2..r6`, `r2b`/`r3b` for
 * the gated confirmations, `swap`/`s-was`/`s-now`). It derives + validates; it
 * does NOT re-implement the runtime.
 */

export interface Step {
  readonly n: number
  readonly caption: string
}

/** A point on the sequence timeline: an integer step plus an intra-step delay (ms). */
export interface TimelinePoint {
  readonly step: number
  /** intra-step delay in ms (default 0) — when in the step the event actually fires */
  readonly delay?: number
}

/** A value that morphs at a point in time (the was→now crossfade). */
export interface SwapSpec<T = string> {
  readonly was: T
  readonly now: T
  readonly at: TimelinePoint
}

/**
 * The single-pass sync/read packet. It DEPARTS at `{ step, delay }` (the action
 * — the `sync`/`generate`/`apply` command — reveals at step entry, so delay is
 * usually 0) and travels `duration` ms, ARRIVING at `{ step, delay + duration }`.
 * The effect must be gated to that ARRIVAL (`animation-delay ≈ duration`), which
 * is why the packet's duration is part of the model, not just its departure.
 */
export interface Packet extends TimelinePoint {
  /** packet travel time in ms — the effect is gated to depart+duration (arrival). */
  readonly duration?: number
}

export interface SyncStoryOpts {
  readonly steps: readonly Step[]
  /**
   * The local pane's change (e.g. the SQLite cell: In Progress → Done), if the
   * story has a distinct pre-sync local effect. OPTIONAL: codegen/iac have no
   * separate local-pane flip — the action IS the sync command at step entry, and
   * the only effect is the remote one gated to arrival.
   */
  readonly local?: { readonly pane: string; readonly swap: SwapSpec }
  /** the single-pass packet: action departs at `{step,delay}`, effect gated to arrival. */
  readonly sync: Packet
  /** the remote pane's change (e.g. the Notion cell), gated to packet ARRIVAL. */
  readonly remote: { readonly pane: string; readonly swap: SwapSpec }
}

/** Thrown when a story violates cause-before-effect. Fails the build. */
export class CausalityError extends Error {
  constructor(message: string) {
    super(`syncStory causality violation: ${message}`)
    this.name = 'CausalityError'
  }
}

const delayOf = (p: TimelinePoint) => p.delay ?? 0

/** Lexicographic compare on (step, delay). <0 = a before b, 0 = same instant, >0 = a after b. */
const cmp = (a: TimelinePoint, b: TimelinePoint): number =>
  a.step !== b.step ? a.step - b.step : delayOf(a) - delayOf(b)

const fmt = (p: TimelinePoint) => `step ${p.step}${delayOf(p) ? ` +${delayOf(p)}ms` : ''}`

export interface SyncStory {
  readonly steps: readonly Step[]
  readonly local?: { readonly pane: string; readonly swap: SwapSpec }
  readonly sync: Packet
  /** the packet's arrival point `{ step, delay+duration }` — where the effect is gated. */
  readonly arrival: TimelinePoint
  readonly remote: { readonly pane: string; readonly swap: SwapSpec }
  /** Cumulative reveal class for a timeline point: step 1 → `only-1`, else `r{step}`. */
  revealClass(at: TimelinePoint): string
  /** Gated reveal class for a confirmation that must wait for its cause (delay>0):
   *  step 2 → `r2b` (types-complete), step 3 → `r3b` (packet-arrival); else the plain class. */
  gatedRevealClass(at: TimelinePoint): string
}

/**
 * Build a validated SyncStory. The assertion is INTRA-STEP (reveal-TIME aware),
 * not step-granular — cause and effect may share a step, but the effect must
 * reveal only after the packet ARRIVES. THROWS `CausalityError` on any violation:
 *   0. the packet must actually travel — arrival strictly after departure
 *      (a zero-duration sync can't gate its effect; that's the effect-at-t=0 bug)
 *   1. any local edit must not come after the packet departs (can't sync first)
 *   2. the remote effect must reveal at/after the packet ARRIVAL (depart+duration),
 *      NOT at step entry — this is the dominant "effect painted while its cause is
 *      still running" bug the causality review catalogued
 *   3. every referenced point must land inside a declared step
 */
export function syncStory(opts: SyncStoryOpts): SyncStory {
  const { steps, local, sync, remote } = opts

  if (steps.length === 0) throw new CausalityError('a story needs at least one step')
  const maxStep = steps.length
  const inRange = (p: TimelinePoint, label: string) => {
    if (p.step < 1 || p.step > maxStep) {
      throw new CausalityError(`${label} at ${fmt(p)} is outside the ${maxStep} declared steps`)
    }
  }
  if (local) inRange(local.swap.at, 'local edit')
  inRange(sync, 'sync (packet departure)')
  inRange(remote.swap.at, 'remote effect')

  const arrival: TimelinePoint = { step: sync.step, delay: delayOf(sync) + (sync.duration ?? 0) }
  inRange(arrival, 'sync (packet arrival)')

  // (0) the packet must travel — a gate with no travel time can't hold the effect back.
  if (cmp(sync, arrival) >= 0) {
    throw new CausalityError(
      `sync packet has no travel time (departs ${fmt(sync)}, arrives ${fmt(arrival)}) — ` +
        `give it a positive \`duration\` so the effect can be gated to its arrival`,
    )
  }
  // (1) any local edit ≤ packet departure — the edit may complete as the sync begins.
  if (local && cmp(local.swap.at, sync) > 0) {
    throw new CausalityError(
      `local edit (${fmt(local.swap.at)}) happens AFTER the sync departs (${fmt(sync)}) — ` +
        `you cannot sync a change before it is made`,
    )
  }
  // (2) remote effect ≥ packet ARRIVAL (intra-step gate). Earlier = effect before cause.
  if (cmp(remote.swap.at, arrival) < 0) {
    throw new CausalityError(
      `remote effect (${fmt(remote.swap.at)}) reveals BEFORE the packet arrives (${fmt(arrival)}) — ` +
        `the remote pane would change while the sync is still in flight (effect before cause). ` +
        `Gate it to arrival via animation-delay ≈ the packet's ${sync.duration ?? 0}ms duration`,
    )
  }

  const revealClass = (at: TimelinePoint): string => (at.step <= 1 ? 'only-1' : `r${at.step}`)
  const gatedRevealClass = (at: TimelinePoint): string => {
    if (delayOf(at) > 0 && at.step === 2) return 'r2b'
    if (delayOf(at) > 0 && at.step === 3) return 'r3b'
    return revealClass(at)
  }

  return { steps, local, sync, arrival, remote, revealClass, gatedRevealClass }
}

/** Convenience: build the `Step[]` from an ordered list of captions. */
export const captionsToSteps = (captions: readonly string[]): readonly Step[] =>
  captions.map((caption, i) => ({ n: i + 1, caption }))

/**
 * ── multiSyncStory — the generalized causal model (notion-md and the
 *    react/codegen/iac ports that follow) ──────────────────────────────────
 *
 * `syncStory` above models ONE local→remote hop with a fixed direction (the
 * pre-sync pane always edits, the post-sync pane always receives). notion-md
 * needs three shapes the single hop can't express:
 *   - REVERSED direction: the Notion (right) pane is the source and the .nmd
 *     (left) pane is the effect — a pull, not a push.
 *   - MULTIPLE crossing edits in one step: the shared/two-way mode has the IDE
 *     editing one line AND Notion editing another, both received on the same sync.
 *   - direction decoupled from pane position: LEFT is always the .nmd, RIGHT is
 *     always Notion; only the arrows (push → / ← pull / ⇄ merge) flip.
 *
 * A `CrossEdit` names its author pane (`from`) and receiver pane (`to`) as DATA,
 * so which side is source vs effect is a property of the story, not baked in.
 * Each edit is asserted INDEPENDENTLY with the same intra-step, arrival-gated
 * cause-before-effect rule as `syncStory` — so a causally inverted md story
 * (e.g. a pull whose IDE receives before the packet lands) FAILS THE BUILD.
 */
export type FlowDirection = 'push' | 'pull' | 'two'

export interface CrossEdit {
  /** stable id for the edited line (e.g. 'pricing', 'enterprise') */
  readonly label: string
  /** the pane that authors this edit (the cause) — e.g. 'ide' | 'notion' */
  readonly from: string
  /** the pane that receives it on sync (the effect) */
  readonly to: string
  /** when the author edits — the cause; must be ≤ the packet departure */
  readonly editAt: TimelinePoint
  /** when the receiver updates — the effect; must be ≥ the packet ARRIVAL */
  readonly receiveAt: TimelinePoint
  /** the was→now morph (optional; a pure-reveal step has none) */
  readonly swap?: SwapSpec
}

export interface MultiSyncStoryOpts {
  readonly steps: readonly Step[]
  /** the single-pass sync packet: departs at `{step,delay}`, arrives +duration. */
  readonly sync: Packet
  /** ≥1 crossing edits; each is asserted for cause-before-effect independently. */
  readonly edits: readonly CrossEdit[]
  /** connector variant — decoupled from pane position (push → / ← pull / ⇄ two). */
  readonly direction: FlowDirection
}

export interface MultiSyncStory {
  readonly steps: readonly Step[]
  readonly sync: Packet
  readonly arrival: TimelinePoint
  readonly edits: readonly CrossEdit[]
  readonly direction: FlowDirection
  /** the pane a role occupies for `label`: 'orig' if it authored, 'recv' if it received. */
  roleOf(label: string, pane: string): 'orig' | 'recv' | undefined
  revealClass(at: TimelinePoint): string
}

/**
 * Build a validated MultiSyncStory. THROWS `CausalityError` if any edit violates
 * cause-before-effect (same three rules as `syncStory`, applied per edit):
 *   0. the packet must travel (arrival strictly after departure)
 *   1. each edit's `editAt` ≤ packet departure (can't sync a change before it's made)
 *   2. each edit's `receiveAt` ≥ packet ARRIVAL (effect not painted while in flight)
 *   3. every referenced point lands inside a declared step
 */
export function multiSyncStory(opts: MultiSyncStoryOpts): MultiSyncStory {
  const { steps, sync, edits, direction } = opts

  if (steps.length === 0) throw new CausalityError('a story needs at least one step')
  if (edits.length === 0) throw new CausalityError('a story needs at least one edit')
  const maxStep = steps.length
  const inRange = (p: TimelinePoint, label: string) => {
    if (p.step < 1 || p.step > maxStep) {
      throw new CausalityError(`${label} at ${fmt(p)} is outside the ${maxStep} declared steps`)
    }
  }

  inRange(sync, 'sync (packet departure)')
  const arrival: TimelinePoint = { step: sync.step, delay: delayOf(sync) + (sync.duration ?? 0) }
  inRange(arrival, 'sync (packet arrival)')

  // (0) the packet must travel — a gate with no travel time can't hold effects back.
  if (cmp(sync, arrival) >= 0) {
    throw new CausalityError(
      `sync packet has no travel time (departs ${fmt(sync)}, arrives ${fmt(arrival)}) — ` +
        `give it a positive \`duration\` so effects can be gated to its arrival`,
    )
  }

  for (const e of edits) {
    inRange(e.editAt, `edit '${e.label}' (author ${e.from})`)
    inRange(e.receiveAt, `edit '${e.label}' (receiver ${e.to})`)
    if (e.from === e.to) {
      throw new CausalityError(`edit '${e.label}' has the same author and receiver ('${e.from}')`)
    }
    // (1) the author edits at/before the packet departs.
    if (cmp(e.editAt, sync) > 0) {
      throw new CausalityError(
        `edit '${e.label}' is authored (${fmt(e.editAt)}) AFTER the sync departs (${fmt(sync)}) — ` +
          `you cannot sync a change before it is made`,
      )
    }
    // (2) the receiver updates at/after the packet ARRIVES (intra-step gate).
    if (cmp(e.receiveAt, arrival) < 0) {
      throw new CausalityError(
        `edit '${e.label}' is received (${fmt(e.receiveAt)}) BEFORE the packet arrives (${fmt(arrival)}) — ` +
          `the ${e.to} pane would change while the sync is still in flight (effect before cause). ` +
          `Gate it to arrival via animation-delay ≈ the packet's ${sync.duration ?? 0}ms duration`,
      )
    }
  }

  const roleOf = (label: string, pane: string): 'orig' | 'recv' | undefined => {
    const e = edits.find((x) => x.label === label)
    if (!e) return undefined
    if (e.from === pane) return 'orig'
    if (e.to === pane) return 'recv'
    return undefined
  }
  const revealClass = (at: TimelinePoint): string => (at.step <= 1 ? 'only-1' : `r${at.step}`)

  return { steps, sync, arrival, edits, direction, roleOf, revealClass }
}
