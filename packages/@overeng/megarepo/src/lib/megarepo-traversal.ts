/**
 * Shared traversal state for recursive megarepo walks.
 *
 * The important invariant is that a traversal node is identified by its
 * canonical worktree path, not by the current `repos/<member>` symlink path.
 * Raw traversal paths can grow forever in symlink cycles.
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Ref, Schema, type ParseResult } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import * as Observability from './observability.ts'

/** Known command/operation families that perform nested megarepo traversal. */
export const MegarepoTraversalPurpose = Schema.Literal('status', 'ls', 'sync').annotations({
  identifier: 'Megarepo.Traversal.Purpose',
})
export type MegarepoTraversalPurpose = typeof MegarepoTraversalPurpose.Type

/** Branded canonical identity for a traversed megarepo root. */
export const MegarepoTraversalNodeKey = Schema.NonEmptyString.pipe(
  Schema.brand('Megarepo.Traversal.NodeKey'),
  Schema.annotations({ identifier: 'Megarepo.Traversal.NodeKey' }),
)
export type MegarepoTraversalNodeKey = typeof MegarepoTraversalNodeKey.Type

/** Result of attempting to enter a megarepo root during recursive traversal. */
export type MegarepoTraversalEnterResult =
  | {
      readonly _tag: 'Enter'
      readonly key: MegarepoTraversalNodeKey
      readonly resolvedRoot: string
    }
  | {
      readonly _tag: 'Cycle'
      readonly key: MegarepoTraversalNodeKey
      readonly resolvedRoot: string
    }

/** Scalar counters for one traversal span. */
export interface MegarepoTraversalStats {
  readonly nodesVisited: number
  readonly cyclesSkipped: number
  readonly maxDepth: number
}

interface MegarepoTraversalState extends MegarepoTraversalStats {
  readonly visited: ReadonlySet<MegarepoTraversalNodeKey>
}

/** Stateful traversal guard shared by one recursive megarepo walk. */
export interface MegarepoTraversal {
  readonly enterRoot: (args: {
    readonly root: AbsoluteDirPath
    readonly depth: number
  }) => Effect.Effect<
    MegarepoTraversalEnterResult,
    PlatformError.PlatformError | ParseResult.ParseError,
    FileSystem.FileSystem
  >
  readonly stats: Effect.Effect<MegarepoTraversalStats>
}

const canonicalizeRoot = Effect.fn('megarepo/traversal/canonicalize-root')(function* (
  root: AbsoluteDirPath,
) {
  const fs = yield* FileSystem.FileSystem
  const resolvedRoot = yield* fs.realPath(root.replace(/\/$/, '')).pipe(
    Effect.map((path) => path.replace(/\/$/, '')),
    Effect.orElseSucceed(() => root.replace(/\/$/, '')),
  )
  const key = yield* Schema.decodeUnknown(MegarepoTraversalNodeKey)(resolvedRoot)
  return { key, resolvedRoot }
})

const initialState: MegarepoTraversalState = {
  visited: new Set(),
  nodesVisited: 0,
  cyclesSkipped: 0,
  maxDepth: 0,
}

/** Create traversal state keyed by canonical worktree identity. */
export const makeMegarepoTraversal = Effect.fn('megarepo/traversal/make')(function* () {
  const stateRef = yield* Ref.make<MegarepoTraversalState>(initialState)

  const enterRoot: MegarepoTraversal['enterRoot'] = Effect.fn('megarepo/traversal/enter-root')(
    function* ({ root, depth }: { readonly root: AbsoluteDirPath; readonly depth: number }) {
      const { key, resolvedRoot } = yield* canonicalizeRoot(root)
      return yield* Ref.modify(
        stateRef,
        (state): [MegarepoTraversalEnterResult, MegarepoTraversalState] => {
          if (state.visited.has(key) === true) {
            return [
              { _tag: 'Cycle', key, resolvedRoot },
              {
                ...state,
                cyclesSkipped: state.cyclesSkipped + 1,
                maxDepth: Math.max(state.maxDepth, depth),
              },
            ]
          }

          const visited = new Set(state.visited)
          visited.add(key)
          return [
            { _tag: 'Enter', key, resolvedRoot },
            {
              visited,
              nodesVisited: state.nodesVisited + 1,
              cyclesSkipped: state.cyclesSkipped,
              maxDepth: Math.max(state.maxDepth, depth),
            },
          ]
        },
      )
    },
  )

  const stats = Ref.get(stateRef).pipe(
    Effect.map(({ nodesVisited, cyclesSkipped, maxDepth }) => ({
      nodesVisited,
      cyclesSkipped,
      maxDepth,
    })),
  )

  return { enterRoot, stats } satisfies MegarepoTraversal
})

/** Run an effect with shared nested traversal state and traversal telemetry. */
export const withMegarepoTraversal = <A, E, R>({
  purpose,
  root,
  all,
  effect,
}: {
  readonly purpose: MegarepoTraversalPurpose
  readonly root: AbsoluteDirPath
  readonly all: boolean
  readonly effect: (traversal: MegarepoTraversal) => Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const traversal = yield* makeMegarepoTraversal()
    const result = yield* effect(traversal)
    const stats = yield* traversal.stats
    yield* Observability.annotateMegarepoTraversalResult(stats)
    return result
  }).pipe(Observability.withMegarepoTraversalSpan({ root, purpose, all }))
