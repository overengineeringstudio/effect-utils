import { Effect } from 'effect'

import type { NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { semanticEqual } from './canonicalizer.ts'
import { tryMergeMarkdownBodies } from './merge.ts'
import type { PorcelainStatus } from './reconcile-core.ts'

/*
 * The `source: shared` strategy — the SOLE base/merge leaf (R32; spec
 * "Internal layering").
 *
 * This is the ONLY module in the reconcile graph that imports the merge planner
 * (`tryMergeMarkdownBodies`) and reasons about a base snapshot. It is reached
 * only via `source: shared`, so the base+merge apparatus is compile-time
 * isolated from the single-source path (R31/R32 enforced by the dependency
 * graph). The stateless core hands `shared-defer` here; nothing else can.
 *
 * The actual base-snapshot READ stays in the Effectful caller (which owns the
 * state store); this leaf takes the resolved base body and computes the 3-way
 * outcome purely, so it can be unit-tested without the state store.
 */

/** 3-way reconcile outcome for a `source: shared` page. */
export type SharedOutcome =
  /** local ≡ remote (or both unchanged from base) — nothing to apply. */
  | { readonly _tag: 'noop' }
  /** non-overlapping edits merged cleanly; `merged` is the body to write back. */
  | { readonly _tag: 'merge'; readonly merged: string }
  /** overlapping edits — write a `conflict.roughdraft` and leave remote unchanged. */
  | {
      readonly _tag: 'conflict'
      readonly baseBody: string
      readonly localBody: string
      readonly remoteBody: string
    }

/**
 * Decide the `source: shared` 3-way outcome from the base, local, and remote
 * bodies. Pure. `--force` is the only override of a divergence and is applied
 * by the caller (it replaces this whole decision with a local-wins push), so it
 * is not a parameter here.
 *
 * - local ≡ remote (R33) ⇒ `noop` (already converged).
 * - remote ≡ base ⇒ accept local (a `merge` to the local body).
 * - local ≡ base ⇒ accept remote (a `noop` on remote; local will be refreshed).
 * - both diverged from base, non-overlapping ⇒ `merge`.
 * - both diverged, overlapping ⇒ `conflict`.
 */
export const decideShared = (input: {
  readonly baseBody: string
  readonly localBody: string
  readonly remoteBody: string
}): SharedOutcome => {
  const { baseBody, localBody, remoteBody } = input

  if (semanticEqual({ a: localBody, b: remoteBody }) === true) return { _tag: 'noop' }
  if (semanticEqual({ a: remoteBody, b: baseBody }) === true) {
    return { _tag: 'merge', merged: localBody }
  }
  if (semanticEqual({ a: localBody, b: baseBody }) === true) return { _tag: 'noop' }

  const merged = tryMergeMarkdownBodies({ baseBody, localBody, remoteBody })
  if (merged !== undefined) return { _tag: 'merge', merged }

  return { _tag: 'conflict', baseBody, localBody, remoteBody }
}

/** git-porcelain word for a `source: shared` outcome. */
export const sharedPorcelain = (outcome: SharedOutcome): PorcelainStatus => {
  switch (outcome._tag) {
    case 'noop':
      return 'in-sync'
    case 'merge':
      return 'diverged'
    case 'conflict':
      return 'diverged'
  }
}

/**
 * Resolve the base body for a `shared` page from its sidecar via a caller-
 * supplied reader, then decide the outcome. Keeping the reader as a parameter
 * (rather than importing the state store) preserves the leaf's testability and
 * keeps the base-read confined to this one module.
 */
export const reconcileShared = <E, R>(input: {
  readonly syncState: NmdSyncStateV1
  readonly localBody: string
  readonly remoteBody: string
  readonly readBase: (syncState: NmdSyncStateV1) => Effect.Effect<string, E, R>
}): Effect.Effect<SharedOutcome, E, R> =>
  Effect.gen(function* () {
    const baseBody = yield* input.readBase(input.syncState)
    return decideShared({ baseBody, localBody: input.localBody, remoteBody: input.remoteBody })
  })
