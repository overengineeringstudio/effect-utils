/**
 * Fail-closed adoption of an existing rendered page (#1093).
 *
 * `adopt()` reconstructs the `CacheTree` a prior `sync()` of the same JSX
 * would have persisted, from (candidate JSX, root pageId, live observation)
 * alone — with zero Notion mutations (GET-only). It exists for stateless
 * consumers whose renderer cache did not survive a redeploy: the documented
 * cold-cache default (`coldBaseline: 'clean'`) archives and re-appends the
 * whole page, while a successful adoption feeds the normal incremental diff
 * and reaches the zero-op fixpoint immediately.
 *
 * ## Binding is strictly positional
 *
 * `blockKey` is intentionally not stored in Notion, so no key recovery
 * problem exists: keys and hashes flow exclusively from the candidate side
 * (`buildCandidateTree`), and candidate child *i* binds to live child *i*
 * under every parent (in-trash blocks excluded). Identical siblings are
 * observationally indistinguishable, which makes index-order assignment the
 * unique binding up to observational equivalence — a canon, not a guess.
 * Reordered *distinct* siblings refuse at both positions; adoption never
 * re-matches by content search.
 *
 * ## Verification is fail-closed
 *
 * Every bound pair is verified before the mapping is trusted:
 *
 * - block content through the readback oracle (`compareReadback`), one node
 *   at a time with children stripped — so a drifted child pins the child,
 *   not its ancestors. Readback's canonicalization and candidate-contextual
 *   masking (R39/R40) absorb the response-shape deltas of the real API;
 *   adoption inherits readback's masked dimensions (T12): uploaded bytes and
 *   provider-owned defaults are presence-verified, not content-verified.
 * - `child_page` / root `<Page>` metadata claims (title/icon/cover) through
 *   `compareReadbackPage` per field against `pages.retrieve`, giving
 *   field-level `PageMetaDrift` refusals; a trashed root refuses outright.
 * - recursion crosses page boundaries and descends whenever EITHER side
 *   expects children, so untracked nested live content surfaces as a
 *   `ChildCountMismatch` instead of being silently ignored.
 *
 * All refusals are collected (not first-fail) and returned in one typed
 * `AdoptionRefusedError`; refusal paths perform zero mutations too.
 *
 * ## Recovery: `onContentDrift: 'adopt-live'`
 *
 * The default refuses on any content drift. `'adopt-live'` keeps every
 * STRUCTURAL check fail-closed (count/type/shape) but adopts drifted nodes
 * with a recorded live marker instead of the candidate hash:
 *
 * - block nodes record `adopt-live:<observedReadbackHash>` in
 *   `CacheNode.hash`. The marker is deliberately not a cache-space hash
 *   (readback hashes and cache hashes are separate spaces, R39) — its only
 *   contract is to be deterministic and never equal the candidate's
 *   request-shape hash, so the next ordinary `sync()` emits exactly one
 *   `update` per drifted node and repairs the live content;
 * - page-metadata fields record the live claim's cache-space hash (computed
 *   through the same `normalizeTitle`/`normalizeIcon`/`normalizeCover` the
 *   sync diff uses), or drop the field when the live side is unset — either
 *   way the next `sync()` emits one `updatePage` for the drifted fields.
 *
 * After that repair sync, strict re-adoption succeeds and `plan()` is empty.
 */
import type { HttpClient } from '@effect/platform'
import { Data, Effect, Either } from 'effect'
import type { ReactNode } from 'react'

import { NotionPages, type NotionConfig } from '@overeng/notion-effect-client'

import { CACHE_SCHEMA_VERSION, type CacheNode, type CacheTree } from '../cache/types.ts'
import { NotionSyncError } from './errors.ts'
import { normalizeCover, normalizeIcon, normalizeTitle } from './icons.ts'
import { observeBlockTree } from './readback-observe.ts'
import {
  compareReadback,
  compareReadbackPage,
  type ObservedBlockTree,
  type ReadbackPageCandidate,
} from './readback.ts'
import {
  buildCandidateTree,
  candidateToCache,
  hashStable,
  type CandidateNode,
  type CandidateRootPage,
} from './sync-diff.ts'

type Json = Record<string, unknown>

/**
 * One reason adoption refused to bind the candidate to the live page. All
 * refusals found in a single pass are collected into
 * {@link AdoptionRefusedError} — adoption never stops at the first one.
 *
 * Hash spaces: `ContentDrift` pins READBACK-space hashes (both sides
 * normalized through the readback oracle — never compare them against
 * `CacheNode.hash`). `PageMetaDrift` pins CACHE-space claim hashes (the
 * same per-field hashes `sync()` diffs on).
 */
export type AdoptionRefusal =
  | {
      readonly _tag: 'ChildCountMismatch'
      readonly parentId: string
      readonly expected: number
      readonly actual: number
      /** Live block ids beyond the candidate's children (untracked content). */
      readonly untrackedLiveIds: readonly string[]
      /** Candidate keys with no live block at their position (missing content). */
      readonly missingCandidateKeys: readonly string[]
    }
  | {
      readonly _tag: 'TypeMismatch'
      readonly parentId: string
      readonly position: number
      readonly key: string
      readonly expectedType: string
      readonly actualType: string
      readonly blockId: string
    }
  | {
      readonly _tag: 'ContentDrift'
      readonly parentId: string
      readonly position: number
      readonly key: string
      readonly blockId: string
      /** Readback-space hash of the candidate node (children excluded). */
      readonly candidateHash: string
      /** Readback-space hash of the observed live block (children excluded). */
      readonly observedHash: string
    }
  | {
      /**
       * The readback oracle cannot normalize this node — raw escape-hatch
       * payloads (`<Raw>`, `template`, `synced_block`, ...) have no generic
       * response-shape normalization, so their live content is unverifiable
       * and adoption fails closed rather than trusting it.
       */
      readonly _tag: 'UnverifiableContent'
      readonly parentId: string
      readonly position: number
      readonly key: string
      readonly blockId: string
      readonly reason: string
    }
  | {
      readonly _tag: 'PageMetaDrift'
      readonly pageId: string
      readonly key: string
      readonly field: 'title' | 'icon' | 'cover'
      /** Cache-space hash of the candidate's claim for this field. */
      readonly expectedHash: string
      /** Cache-space hash of the live value, or `undefined` when unset live. */
      readonly actualHash: string | undefined
    }
  | { readonly _tag: 'RootTrashed'; readonly pageId: string }

/** Typed failure carrying every refusal found in one adoption pass. */
export class AdoptionRefusedError extends Data.TaggedError('AdoptionRefusedError')<{
  readonly refusals: readonly AdoptionRefusal[]
}> {}

/** Thrown by `compareReadback` when the oracle cannot verify a node. */
class ReadbackUnverifiableError extends Data.TaggedError('ReadbackUnverifiableError')<{
  readonly cause: unknown
}> {}

/**
 * What to do when a bound block or page-metadata field verifies structurally
 * but its content drifted from the candidate. `'refuse'` (default) fails the
 * adoption; `'adopt-live'` records a live marker at exactly the drifted nodes
 * so the next ordinary `sync()` repairs them — see the module docs.
 */
export type ContentDriftPolicy = 'refuse' | 'adopt-live'

/**
 * Tri-state page-metadata override produced by verification under
 * `'adopt-live'`: `string` = record this live cache-space hash instead of
 * the candidate's; `null` = record NO hash (live side unset) so the next
 * sync repairs by setting the field; key absent = claim verified, keep the
 * candidate hash.
 */
type PageMetaOverride = Partial<Record<'titleHash' | 'iconHash' | 'coverHash', string | null>>

/** Page-metadata claims common to `CandidateRootPage` and page-kind nodes. */
type PageMetaCandidate = Pick<
  CandidateRootPage,
  'title' | 'icon' | 'cover' | 'titleHash' | 'iconHash' | 'coverHash'
>

/**
 * Resolve one root-metadata hash from the candidate claim plus its
 * `'adopt-live'` override: `null` = live side unset (record no hash),
 * `string` = record the live hash, `undefined` = claim verified (keep the
 * candidate's).
 */
const pickRootHash = (
  candHash: string | undefined,
  override: string | null | undefined,
): string | undefined => {
  if (override === null) return undefined
  if (override !== undefined) return override
  return candHash
}

const retrievePage = (pageId: string) =>
  NotionPages.retrieve({ pageId }).pipe(
    Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause })),
  )

/**
 * Adopt an existing rendered page: bind the candidate's keys and hashes to
 * the live block/page ids and return the `CacheTree` a prior `sync()` of the
 * same element would have persisted — or fail with every refusal found.
 * Performs zero Notion mutations in all outcomes (GET-only).
 *
 * The returned tree is not persisted; save it through your `NotionCache`
 * (or pass it to `InMemoryCache.make(tree)`) and the next `sync()` diffs
 * incrementally against it.
 */
export const adopt = (
  element: ReactNode,
  opts: {
    readonly pageId: string
    /** See {@link ContentDriftPolicy}. Defaults to `'refuse'`. */
    readonly onContentDrift?: ContentDriftPolicy
  },
): Effect.Effect<
  CacheTree,
  AdoptionRefusedError | NotionSyncError,
  NotionConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const policy: ContentDriftPolicy = opts.onContentDrift ?? 'refuse'
    const candidate = buildCandidateTree(element, opts.pageId)
    const refusals: AdoptionRefusal[] = []
    const hashOverrides = new Map<CandidateNode, string>()
    const pageMetaOverrides = new Map<CandidateNode, PageMetaOverride>()

    /**
     * Verify one page's title/icon/cover claims against its `pages.retrieve`
     * response. Equality per field goes through `compareReadbackPage` so the
     * response-shape deltas the real API introduces (decorated title spans,
     * the A07 built-in-icon rewrite, uploaded-cover signed URLs) are absorbed
     * by the shipped masking instead of a hand-rolled comparison.
     */
    const verifyPageMeta = (
      cand: PageMetaCandidate,
      livePage: Json,
      pageId: string,
      key: string,
    ): PageMetaOverride => {
      const out: PageMetaOverride = {}
      const liveTitle = (livePage.properties as Json | undefined)?.title as
        | { title?: unknown }
        | undefined
      const liveOf = {
        title: liveTitle?.title,
        icon: livePage.icon,
        cover: livePage.cover,
      } as const
      const liveCacheHash = {
        title: (): string | undefined =>
          liveOf.title == null ? undefined : hashStable(normalizeTitle(liveOf.title)),
        icon: (): string | undefined =>
          liveOf.icon == null ? undefined : hashStable(normalizeIcon(liveOf.icon)),
        cover: (): string | undefined =>
          liveOf.cover == null ? undefined : hashStable(normalizeCover(liveOf.cover)),
      } as const
      const check = (
        field: 'title' | 'icon' | 'cover',
        candHash: string | undefined,
        claim: ReadbackPageCandidate,
      ): void => {
        if (candHash === undefined) return
        const cmp = compareReadbackPage({ candidate: claim, observed: livePage })
        if (cmp.equal) return
        if (policy === 'adopt-live') out[`${field}Hash`] = liveCacheHash[field]() ?? null
        else {
          refusals.push({
            _tag: 'PageMetaDrift',
            pageId,
            key,
            field,
            expectedHash: candHash,
            actualHash: liveCacheHash[field](),
          })
        }
      }
      check('title', cand.titleHash, { title: cand.title })
      check('icon', cand.iconHash, { icon: cand.icon })
      check('cover', cand.coverHash, { cover: cand.cover })
      return out
    }

    /**
     * Bind and verify one parent's candidate children against the observed
     * live children, positionally. `observed` comes from `observeBlockTree`,
     * so in-trash blocks are already excluded and nested children are only
     * populated where the live side has them.
     */
    const walkChildren = (
      parentId: string,
      cands: readonly CandidateNode[],
      observed: readonly ObservedBlockTree[],
    ): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
      Effect.gen(function* () {
        if (observed.length !== cands.length) {
          refusals.push({
            _tag: 'ChildCountMismatch',
            parentId,
            expected: cands.length,
            actual: observed.length,
            untrackedLiveIds: observed.slice(cands.length).map((o) => o.block.id as string),
            missingCandidateKeys: cands.slice(observed.length).map((c) => c.key),
          })
        }
        const n = Math.min(observed.length, cands.length)
        for (let i = 0; i < n; i++) {
          const cand = cands[i]!
          const obs = observed[i]!
          const blockId = obs.block.id as string
          const liveType = obs.block.type as string
          if (liveType !== cand.type) {
            refusals.push({
              _tag: 'TypeMismatch',
              parentId,
              position: i,
              key: cand.key,
              expectedType: cand.type,
              actualType: liveType,
              blockId,
            })
            continue
          }
          cand.blockId = blockId
          if (cand.nodeKind === 'page') {
            const page = (yield* retrievePage(blockId)) as unknown as Json
            const override = verifyPageMeta(cand, page, blockId, cand.key)
            if (Object.keys(override).length > 0) pageMetaOverrides.set(cand, override)
            // Page boundary: the sub-page's blocks are their own observation
            // scope (observeBlockTree stops at child_page).
            const subObserved = yield* observeBlockTree({ blockId })
            yield* walkChildren(blockId, cand.children, subObserved)
            continue
          }
          // Content gate: one node at a time with children stripped on both
          // sides, so a drifted descendant pins the descendant (below), not
          // this node. compareReadback carries the masking context (R40).
          const verified = yield* Effect.either(
            Effect.try({
              try: () =>
                compareReadback({
                  candidate: { rootId: parentId, children: [{ ...cand, children: [] }] },
                  observed: [{ block: obs.block, children: [] }],
                }),
              catch: (cause) => new ReadbackUnverifiableError({ cause }),
            }),
          )
          if (Either.isLeft(verified)) {
            const { cause } = verified.left
            refusals.push({
              _tag: 'UnverifiableContent',
              parentId,
              position: i,
              key: cand.key,
              blockId,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          } else if (!verified.right.equal) {
            const cmp = verified.right
            if (policy === 'adopt-live') {
              hashOverrides.set(cand, `adopt-live:${cmp.observedHash}`)
            } else {
              refusals.push({
                _tag: 'ContentDrift',
                parentId,
                position: i,
                key: cand.key,
                blockId,
                candidateHash: cmp.candidateHash,
                observedHash: cmp.observedHash,
              })
            }
          }
          // Recurse when EITHER side expects nested blocks — an expected-empty
          // candidate against a live parent with children must surface the
          // untracked nested content as a ChildCountMismatch (and vice versa).
          if (cand.children.length > 0 || obs.children.length > 0) {
            yield* walkChildren(blockId, cand.children, obs.children)
          }
        }
      })

    // Retrieve the root page BEFORE walking its blocks: per A09,
    // `blocks.children.list` 404s for archived pages, so observing first
    // would exit with NotionSyncError('notion-retrieve-failed') and the
    // typed RootTrashed refusal below could never fire. A trashed root
    // fails closed immediately.
    const liveRootPage = (yield* retrievePage(opts.pageId)) as unknown as Json
    if (liveRootPage.in_trash === true) {
      return yield* new AdoptionRefusedError({
        refusals: [{ _tag: 'RootTrashed', pageId: opts.pageId }],
      })
    }
    const rootObserved = yield* observeBlockTree({ blockId: opts.pageId })
    yield* walkChildren(opts.pageId, candidate.children, rootObserved)

    // Root-page metadata: only observable when the JSX carried a <Page>
    // wrapper with actual claims — otherwise root metadata is out of scope,
    // mirroring sync()'s own contract.
    let rootMeta: Pick<CacheTree, 'rootTitleHash' | 'rootIconHash' | 'rootCoverHash'> = {}
    const rootPage = candidate.rootPage
    if (
      rootPage !== undefined &&
      (rootPage.titleHash !== undefined ||
        rootPage.iconHash !== undefined ||
        rootPage.coverHash !== undefined)
    ) {
      const override = verifyPageMeta(rootPage, liveRootPage, opts.pageId, '<root>')
      const rootTitleHash = pickRootHash(rootPage.titleHash, override.titleHash)
      const rootIconHash = pickRootHash(rootPage.iconHash, override.iconHash)
      const rootCoverHash = pickRootHash(rootPage.coverHash, override.coverHash)
      rootMeta = {
        ...(rootTitleHash !== undefined ? { rootTitleHash } : {}),
        ...(rootIconHash !== undefined ? { rootIconHash } : {}),
        ...(rootCoverHash !== undefined ? { rootCoverHash } : {}),
      }
    }

    if (refusals.length > 0) {
      return yield* new AdoptionRefusedError({ refusals })
    }

    // Every position is bound — the public primitive turns the candidate into
    // a cache snapshot; then patch in the adopt-live overrides in lockstep.
    const base = candidateToCache(candidate, CACHE_SCHEMA_VERSION)
    const patch = (
      candNodes: readonly CandidateNode[],
      cacheNodes: readonly CacheNode[],
    ): readonly CacheNode[] =>
      cacheNodes.map((node, i) => {
        const cand = candNodes[i]!
        const meta = pageMetaOverrides.get(cand)
        const withChildren: CacheNode = {
          ...node,
          hash: hashOverrides.get(cand) ?? node.hash,
          children: patch(cand.children, node.children),
        }
        if (meta === undefined) return withChildren
        const applied: Json = { ...withChildren }
        for (const field of ['titleHash', 'iconHash', 'coverHash'] as const) {
          const value = meta[field]
          if (value === undefined) continue
          if (value === null) delete applied[field]
          else applied[field] = value
        }
        return applied as unknown as CacheNode
      })

    return {
      ...base,
      children: patch(candidate.children, base.children),
      ...rootMeta,
    }
  })
