/**
 * Native Notion `status` schema convergence planner (issue #803).
 *
 * The Notion API (version 2026-03-11) is effectively add-only for `status`:
 * adding an option works, but recoloring is rejected, renaming is a silent
 * no-op, and all group operations are silently ignored. The `options` PATCH has
 * declarative REPLACE semantics — omitting an option deletes it. See
 * `context/notion-schema-iac/` for the full capability matrix and rationale.
 *
 * This module is the safety core: a pure planner that classifies each option
 * difference, and a payload builder that performs the one safe write (create a
 * missing option) without ever triggering the REPLACE deletion trap.
 */

import type { SelectColor, SelectOptionConfig } from '@overeng/notion-effect-schema'

// -----------------------------------------------------------------------------
// Config / policy
// -----------------------------------------------------------------------------

/** How to treat a live option that is not in the desired set. */
export type ExtrasPolicy = 'fail' | 'ignore' | 'warn'

/** Convergence policy for a single status property. */
export interface StatusConvergePolicy {
  /** Create options present in desired but absent live. */
  readonly createMissing: boolean
  /** What to do with a live option absent from desired (never deletes). */
  readonly extras: ExtrasPolicy
}

/** Fail-closed defaults: create missing options, refuse on unexpected extras. */
export const defaultStatusConvergePolicy: StatusConvergePolicy = {
  createMissing: true,
  extras: 'fail',
}

/** Authored desired state for one status property (the apply intent surface). */
export interface DesiredStatusProperty {
  /** Desired option names. Missing ones are created on apply. */
  readonly options: readonly string[]
  /** Advisory desired colors (drift-report only; the API cannot recolor). */
  readonly colors?: Readonly<Record<string, SelectColor>>
  /** Per-property policy overrides. */
  readonly policy?: Partial<StatusConvergePolicy>
}

// -----------------------------------------------------------------------------
// Plan model
// -----------------------------------------------------------------------------

/**
 * Per-option classification. Exactly one of these is emitted per desired option
 * and per extra live option.
 */
export type StatusOptionDecision =
  /** Desired option absent live; will be created (the only applyable write). */
  | { readonly _tag: 'create'; readonly name: string; readonly color: SelectColor }
  /** Desired option present with matching (or unspecified) color. No action. */
  | { readonly _tag: 'matches'; readonly name: string; readonly id: string }
  /** Desired option present but live color differs. UI-action-required (API cannot recolor). */
  | {
      readonly _tag: 'color-drift'
      readonly name: string
      readonly id: string
      readonly liveColor: SelectColor
      readonly desiredColor: SelectColor
    }
  /** Desired option absent live, but `createMissing` is off. Reported, not applied. */
  | { readonly _tag: 'missing-unaddable'; readonly name: string }
  /** Live option not in desired. Never deleted; handled per `extras` policy. */
  | {
      readonly _tag: 'extra-remote'
      readonly name: string
      readonly id: string
      readonly policy: ExtrasPolicy
    }

/** A classified convergence plan for one status property. */
export interface StatusConvergePlan {
  readonly property: string
  readonly decisions: readonly StatusOptionDecision[]
  /** The only applyable writes: options to create. */
  readonly creates: readonly { readonly name: string; readonly color: SelectColor }[]
  /** True if any decision fails closed (an `extra-remote` under `fail` policy). */
  readonly blocked: boolean
  /** Decisions the API cannot apply; surface to the operator for manual UI action. */
  readonly uiActionRequired: readonly StatusOptionDecision[]
}

// -----------------------------------------------------------------------------
// Planner
// -----------------------------------------------------------------------------

/**
 * Classify desired-vs-live status options into a fail-closed convergence plan.
 *
 * Pure: takes a freshly observed live option set and the authored desired
 * state, returns the plan. No I/O. Groups are intentionally not planned — the
 * API cannot write them (they are drift-report only, handled by `diff`).
 */
export const planStatusConvergence = (input: {
  readonly property: string
  readonly liveOptions: readonly SelectOptionConfig[]
  readonly desired: DesiredStatusProperty
}): StatusConvergePlan => {
  const policy: StatusConvergePolicy = { ...defaultStatusConvergePolicy, ...input.desired.policy }
  const liveByName = new Map(input.liveOptions.map((o) => [o.name, o]))
  const desiredSet = new Set(input.desired.options)
  const decisions: StatusOptionDecision[] = []

  for (const name of input.desired.options) {
    const live = liveByName.get(name)
    const desiredColor = input.desired.colors?.[name]

    if (live === undefined) {
      decisions.push(
        policy.createMissing === true
          ? { _tag: 'create', name, color: desiredColor ?? 'default' }
          : { _tag: 'missing-unaddable', name },
      )
    } else if (desiredColor !== undefined && desiredColor !== live.color) {
      decisions.push({
        _tag: 'color-drift',
        name,
        id: live.id,
        liveColor: live.color,
        desiredColor,
      })
    } else {
      decisions.push({ _tag: 'matches', name, id: live.id })
    }
  }

  for (const live of input.liveOptions) {
    if (desiredSet.has(live.name) === false) {
      decisions.push({ _tag: 'extra-remote', name: live.name, id: live.id, policy: policy.extras })
    }
  }

  const creates = decisions.flatMap((d) =>
    d._tag === 'create' ? [{ name: d.name, color: d.color }] : [],
  )
  const blocked = decisions.some((d) => d._tag === 'extra-remote' && d.policy === 'fail')
  const uiActionRequired = decisions.filter((d) => d._tag === 'color-drift')

  return { property: input.property, decisions, creates, blocked, uiActionRequired }
}

// -----------------------------------------------------------------------------
// Safe write payload
// -----------------------------------------------------------------------------

/** A `status.options` entry: existing options referenced by id, new ones by name+color. */
export type StatusOptionWrite =
  | { readonly id: string }
  | { readonly name: string; readonly color: SelectColor }

/**
 * Build the `status.options` array for a safe additive write.
 *
 * Critical: the Notion `options` PATCH is declarative REPLACE — any option not
 * present in the payload is deleted. So we echo every live option back by id and
 * append the new ones. This is the empirically-validated preserve-and-append
 * primitive (see `.experiments/0001`); sending only the new options would wipe
 * the rest.
 */
export const buildAddOptionsPayload = (input: {
  readonly liveOptions: readonly SelectOptionConfig[]
  readonly creates: readonly { readonly name: string; readonly color: SelectColor }[]
}): { readonly options: readonly StatusOptionWrite[] } => ({
  options: [
    ...input.liveOptions.map((o) => ({ id: o.id })),
    ...input.creates.map((c) => ({ name: c.name, color: c.color })),
  ],
})
