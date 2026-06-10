import type { NmdLocalState } from '@overeng/notion-effect-client'

import { semanticEqual } from './canonicalizer.ts'

/*
 * The stateless per-page reconcile core (R31/R32; spec "Internal layering").
 *
 * This module decides the per-page outcome from `render(local)` and
 * `read(current remote)` under the R33 canonical relation. It is the pure
 * heart of `status` and `sync`: it imports the canonicalizer ONLY — never the
 * merge planner and never a base-snapshot read. A single-source code path is
 * therefore structurally unable to construct a base (R31/R32 enforced by the
 * dependency graph, not by discipline).
 *
 * For `source: shared` the core does not decide the merge; it emits
 * `shared-defer`, and the `shared` strategy leaf (the SOLE base/merge importer)
 * takes over. The core never sees a base.
 */

/**
 * Per-page reconcile outcome from the dispatch table (spec). The action is
 * decided from `source`, the presence of `page_id`, and the live R33 compare.
 *
 * `refuse` is the structural footgun guard: a wrong-direction push is
 * impossible because a `remote` file has no push branch and a `local` file's
 * push is the mirror operation, never a clobber decided by a flag.
 */
export type ReconcileDecision =
  /** rendered local ≡ current remote (R33) — nothing to do. */
  | { readonly _tag: 'noop' }
  /** `source: local`, unbound — create the remote page under `parent`. */
  | { readonly _tag: 'create' }
  /** `source: local`, bound, local ≢ remote — mirror local → remote. */
  | { readonly _tag: 'push' }
  /** `source: remote`, remote ≢ local — overwrite local body from remote. */
  | { readonly _tag: 'pull' }
  /**
   * Wrong-direction reconcile refused (never clobbers). `reason` explains and,
   * where applicable, points at `clone --as shared`.
   */
  | { readonly _tag: 'refuse'; readonly reason: string }
  /** `source: shared` — hand off to the base+merge leaf. */
  | { readonly _tag: 'shared-defer' }

/**
 * The live R33 comparison inputs the core decides over. `renderedLocal` is the
 * canonicalizable local body; `currentRemote` is the freshly read remote body.
 * Both are compared under `semanticEqual` — no stored base is involved, so the
 * poisoned-noop class is unreachable for single-source pages.
 */
export interface ReconcileCompare {
  readonly renderedLocal: string
  readonly currentRemote: string
}

/**
 * Decide the per-page reconcile outcome. Pure; total over the gated
 * `NmdLocalState` union. `compare` is undefined only for the unbound-local case
 * (no remote yet exists to read).
 *
 * Single-source statelessness (R11/R31): the decision is a live
 * `renderedLocal ⇄ currentRemote` compare with no stored base.
 *
 * - `source: local` bound — equivalent ⇒ `noop`; otherwise ⇒ `push`. `source:
 *   local` declares local authority (a mirror), so the push is the guarded
 *   live-re-read mirror operation, not a base-anchored merge. (The dispatch
 *   table's "remote moved underneath ⇒ REFUSE" row is the `source: shared`
 *   safety story; a user wanting that safety opts into `shared`.)
 * - `source: remote` — equivalent ⇒ `noop`; remote changed ⇒ `pull`; a local
 *   hand-edit is never pushed (the file declares Notion authority), so a local
 *   divergence that the pull would overwrite is surfaced by the caller, not
 *   silently clobbered — see `decideRemote`.
 * - `source: shared` ⇒ `shared-defer` (the leaf owns base+merge).
 */
export const decideReconcile = (input: {
  readonly local: NmdLocalState
  readonly compare: ReconcileCompare | undefined
}): ReconcileDecision => {
  switch (input.local._tag) {
    case 'local-unbound':
      return { _tag: 'create' }
    case 'local-bound': {
      if (input.compare === undefined) return { _tag: 'create' }
      return semanticEqual({
        a: input.compare.renderedLocal,
        b: input.compare.currentRemote,
      }) === true
        ? { _tag: 'noop' }
        : { _tag: 'push' }
    }
    case 'remote': {
      if (input.compare === undefined) {
        return {
          _tag: 'refuse',
          reason: 'source: remote requires a readable remote page; none was found',
        }
      }
      return decideRemote(input.compare)
    }
    case 'shared-bound':
      return { _tag: 'shared-defer' }
  }
}

/**
 * `source: remote` decision. The file declares Notion authority: local
 * hand-edits are NOT pushed. So:
 *
 * - rendered local ≡ remote ⇒ `noop`.
 * - rendered local ≢ remote ⇒ `pull` — overwrite the local body from remote.
 *
 * The pull overwrites local edits by design (the file opted into remote
 * authority). The CLI surfaces a warning when local was hand-edited so the user
 * can switch to `source: shared`; the engine never silently pushes the edit the
 * wrong way.
 */
const decideRemote = (compare: ReconcileCompare): ReconcileDecision =>
  semanticEqual({ a: compare.renderedLocal, b: compare.currentRemote }) === true
    ? { _tag: 'noop' }
    : { _tag: 'pull' }

/**
 * git-porcelain status word for a decision (R30/R36 vocabulary). `status` is
 * read-only and reports these without mutating.
 */
export type PorcelainStatus = 'in-sync' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'unbound'

/** Map a reconcile decision to its read-only git-porcelain status word. */
export const porcelainStatus = (decision: ReconcileDecision): PorcelainStatus => {
  switch (decision._tag) {
    case 'noop':
      return 'in-sync'
    case 'create':
      return 'unbound'
    case 'push':
      return 'local-ahead'
    case 'pull':
      return 'remote-ahead'
    case 'refuse':
      return 'diverged'
    case 'shared-defer':
      // shared status is refined by the leaf's 3-way result; default to diverged
      // until the leaf reports in-sync/merge/conflict.
      return 'diverged'
  }
}
