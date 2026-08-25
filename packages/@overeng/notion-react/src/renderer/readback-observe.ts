import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Stream } from 'effect'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'

import { NotionSyncError } from './errors.ts'
import type { ObservedBlockTree } from './readback.ts'

/**
 * Observe a page's (or any block's) live subtree as the `ObservedBlockTree`
 * shape `compareReadback` consumes: one `blocks.children` list per node with
 * `has_children`, recursively, with in-trash blocks dropped.
 *
 * Effectful companion to the pure readback oracle — kept in its own module so
 * `readback.ts` stays a pure function of its inputs (usable against
 * hand-written fixtures and non-client observations without pulling the
 * Notion client into the import graph).
 *
 * `child_page` blocks are NOT recursed into: their children belong to
 * another page, which the readback oracle treats as an identity boundary
 * (see readback.ts) — observe the sub-page separately with its own id.
 *
 * Cost: one paginated GET per block that has children, sequentially. There is
 * no snapshot isolation — a writer racing the walk can produce a tree no
 * single instant ever exhibited; treat the observation (and any comparison
 * built on it) as advisory for the observed window, exactly like `plan()`.
 */
export const observeBlockTree = (input: {
  readonly blockId: string
}): Effect.Effect<
  readonly ObservedBlockTree[],
  NotionSyncError,
  NotionConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const children = yield* Stream.runCollect(
      NotionBlocks.retrieveChildrenStream({ blockId: input.blockId }),
    ).pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'notion-retrieve-failed', cause })),
    )
    const out: ObservedBlockTree[] = []
    for (const block of Chunk.toReadonlyArray(children)) {
      if (block.in_trash === true) continue
      const nested =
        block.has_children === true && block.type !== 'child_page'
          ? yield* observeBlockTree({ blockId: block.id })
          : []
      out.push({ block: block as unknown as Record<string, unknown>, children: nested })
    }
    return out
  })
