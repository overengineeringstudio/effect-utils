import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'

import { type Block, BlockSchema, type BlockType } from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { del, get, patch } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'

/** Block children response */
const BlockChildrenResponseSchema = PaginatedResponse(BlockSchema)

/** Append block children response */
const AppendBlockChildrenResponseSchema = Schema.Struct({
  object: Schema.Literal('list'),
  results: Schema.Array(BlockSchema),
})

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a block */
export interface RetrieveBlockOptions {
  /** Block ID to retrieve */
  readonly blockId: string
}

/** Options for retrieving block children */
export interface RetrieveBlockChildrenOptions extends PaginationOptions {
  /** Block ID to retrieve children for */
  readonly blockId: string
}

/** Options for appending block children */
export interface AppendBlockChildrenOptions {
  /** Block ID to append children to */
  readonly blockId: string
  /** Block objects to append */
  readonly children: readonly unknown[]
  /** Append after this block ID (optional) */
  readonly after?: string
}

/** Options for updating a block */
export interface UpdateBlockOptions {
  /** Block ID to update */
  readonly blockId: string
  /** Block type-specific content to update */
  readonly [key: string]: unknown
}

/** Options for deleting a block */
export interface DeleteBlockOptions {
  /** Block ID to delete */
  readonly blockId: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a block by ID.
 *
 * @see https://developers.notion.com/reference/retrieve-a-block
 */
export const retrieve = Effect.fn('NotionBlocks.retrieve')(function* (opts: RetrieveBlockOptions) {
  return yield* get({ path: `/blocks/${opts.blockId}`, responseSchema: BlockSchema })
})

/** Internal helper to build query params for block children */
const buildBlockChildrenParams = (opts: RetrieveBlockChildrenOptions): string => {
  const params = new URLSearchParams()
  if (opts.startCursor !== undefined) params.set('start_cursor', opts.startCursor)
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize))
  return params.toString()
}

/** Internal raw retrieveChildren - used by both retrieveChildren and retrieveChildrenStream */
const retrieveChildrenRaw = (
  opts: RetrieveBlockChildrenOptions,
): Effect.Effect<PaginatedResult<Block>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const queryString = buildBlockChildrenParams(opts)
    const path = `/blocks/${opts.blockId}/children${queryString ? `?${queryString}` : ''}`
    const response = yield* get({ path, responseSchema: BlockChildrenResponseSchema })
    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionBlocks.retrieveChildren', {
      attributes: { 'notion.block_id': opts.blockId },
    }),
  )

/**
 * Retrieve block children with pagination.
 *
 * Returns a single page of results with cursor for next page.
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveChildren = (
  opts: RetrieveBlockChildrenOptions,
): Effect.Effect<PaginatedResult<Block>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  retrieveChildrenRaw(opts)

/**
 * Retrieve block children with automatic pagination.
 *
 * Returns a stream that automatically fetches all pages.
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveChildrenStream = (
  opts: Omit<RetrieveBlockChildrenOptions, 'startCursor'>,
): Stream.Stream<Block, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const childrenOpts: RetrieveBlockChildrenOptions = Option.isSome(cursor)
          ? { ...opts, startCursor: cursor.value }
          : { ...opts }
        return retrieveChildrenRaw(childrenOpts).pipe(
          Effect.map((result) => {
            const chunk = Chunk.fromIterable(result.results)

            if (!result.hasMore || Option.isNone(result.nextCursor)) {
              return Option.some([chunk, Option.none()] as const)
            }

            return Option.some([chunk, Option.some(Option.some(result.nextCursor.value))] as const)
          }),
        )
      },
    }),
  )

/**
 * Append children blocks to a parent block.
 *
 * @see https://developers.notion.com/reference/patch-block-children
 */
export const append = Effect.fn('NotionBlocks.append')(function* (
  opts: AppendBlockChildrenOptions,
) {
  const body: Record<string, unknown> = {
    children: opts.children,
  }

  if (opts.after !== undefined) {
    body.after = opts.after
  }

  return yield* patch({
    path: `/blocks/${opts.blockId}/children`,
    body,
    responseSchema: AppendBlockChildrenResponseSchema,
  })
})

/**
 * Update a block.
 *
 * @see https://developers.notion.com/reference/update-a-block
 */
export const update = Effect.fn('NotionBlocks.update')(function* (opts: UpdateBlockOptions) {
  const { blockId, ...body } = opts

  return yield* patch({ path: `/blocks/${blockId}`, body, responseSchema: BlockSchema })
})

/**
 * Delete (archive) a block.
 *
 * @see https://developers.notion.com/reference/delete-a-block
 */
export const deleteBlock = Effect.fn('NotionBlocks.delete')(function* (opts: DeleteBlockOptions) {
  return yield* del({ path: `/blocks/${opts.blockId}`, responseSchema: BlockSchema })
})

// -----------------------------------------------------------------------------
// Recursive Block Fetching Types
// -----------------------------------------------------------------------------

/** Block types that can have nested children */
const BLOCK_TYPES_WITH_CHILDREN: ReadonlySet<BlockType> = new Set([
  'toggle',
  'callout',
  'quote',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'column_list',
  'column',
  'table',
  'synced_block',
  'template',
])

/** Block with depth information for flat stream output */
export interface BlockWithDepth {
  /** The block object */
  readonly block: Block
  /** Depth level (0 = top-level) */
  readonly depth: number
  /** Parent block ID (null for top-level blocks) */
  readonly parentId: string | null
}

/** Tree node for hierarchical block structure */
export interface BlockTreeNode {
  /** The block object */
  readonly block: Block
  /** Children blocks as tree nodes */
  readonly children: readonly BlockTreeNode[]
}

/** Block tree (array of root-level nodes) */
export type BlockTree = readonly BlockTreeNode[]

/** Options for recursive block fetching */
export interface RetrieveNestedOptions {
  /** Block ID (page or block) to retrieve children for */
  readonly blockId: string
  /** Maximum depth to recurse (undefined = unlimited) */
  readonly maxDepth?: number
  /** Block types to skip fetching children for */
  readonly skipChildrenFor?: readonly BlockType[]
  /** Concurrency for parallel child fetching (default: 3) */
  readonly concurrency?: number
  /** Page size for pagination (default: 100) */
  readonly pageSize?: number
}

// -----------------------------------------------------------------------------
// Recursive Block Fetching Implementation
// -----------------------------------------------------------------------------

/** Check if a block can have children that need fetching */
const canHaveChildren = (opts: { block: Block; skipTypes: ReadonlySet<BlockType> }): boolean => {
  const { block, skipTypes } = opts
  if (!block.has_children) return false
  if (skipTypes.has(block.type)) return false
  return BLOCK_TYPES_WITH_CHILDREN.has(block.type)
}

/**
 * Retrieve all nested blocks as a flat stream with depth information.
 *
 * Recursively fetches children for block types that support nesting
 * (toggles, callouts, columns, etc.) and emits them in depth-first order.
 *
 * @example
 * ```ts
 * const blocks = NotionBlocks.retrieveAllNested({
 *   blockId: pageId,
 *   maxDepth: 10,
 * })
 *
 * yield* Stream.runForEach(blocks, (item) =>
 *   Effect.log(`${'  '.repeat(item.depth)}${item.block.type}`)
 * )
 * ```
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveAllNested = (
  opts: RetrieveNestedOptions,
): Stream.Stream<BlockWithDepth, NotionApiError, NotionConfig | HttpClient.HttpClient> => {
  const skipTypes = new Set(opts.skipChildrenFor ?? [])
  const maxDepth = opts.maxDepth
  const concurrency = opts.concurrency ?? 3
  const pageSize = opts.pageSize ?? 100

  const fetchBlocksRecursive = (args: {
    blockId: string
    parentId: string | null
    depth: number
  }): Stream.Stream<BlockWithDepth, NotionApiError, NotionConfig | HttpClient.HttpClient> => {
    const { blockId, parentId, depth } = args
    // Bail if we've exceeded max depth
    if (maxDepth !== undefined && depth > maxDepth) {
      return Stream.empty
    }

    // Fetch direct children
    const childrenStream = retrieveChildrenStream({ blockId, pageSize })

    // For each child, emit it and recursively fetch its children
    return Stream.flatMap(
      childrenStream,
      (block) => {
        const item: BlockWithDepth = { block, depth, parentId }

        // Check if we should recurse into this block's children
        if (canHaveChildren({ block, skipTypes })) {
          // Emit this block, then recurse into its children
          return Stream.concat(
            Stream.succeed(item),
            fetchBlocksRecursive({ blockId: block.id, parentId: block.id, depth: depth + 1 }),
          )
        }

        // Just emit this block
        return Stream.succeed(item)
      },
      { concurrency },
    )
  }

  return fetchBlocksRecursive({ blockId: opts.blockId, parentId: null, depth: 0 }).pipe(
    Stream.tapError((error) =>
      Effect.logError('Failed to retrieve nested blocks', {
        blockId: opts.blockId,
        error,
      }),
    ),
  )
}

/**
 * Retrieve all nested blocks as a tree structure.
 *
 * Recursively fetches children for block types that support nesting
 * and returns a hierarchical tree structure.
 *
 * @example
 * ```ts
 * const tree = yield* NotionBlocks.retrieveAsTree({
 *   blockId: pageId,
 * })
 *
 * for (const node of tree) {
 *   console.log(node.block.type, node.children.length)
 * }
 * ```
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveAsTree = (
  opts: RetrieveNestedOptions,
): Effect.Effect<BlockTree, NotionApiError, NotionConfig | HttpClient.HttpClient> => {
  const skipTypes = new Set(opts.skipChildrenFor ?? [])
  const maxDepth = opts.maxDepth
  const concurrency = opts.concurrency ?? 3
  const pageSize = opts.pageSize ?? 100

  const fetchTreeRecursive = (args: {
    blockId: string
    depth: number
  }): Effect.Effect<BlockTree, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const { blockId, depth } = args
      // Bail if we've exceeded max depth
      if (maxDepth !== undefined && depth > maxDepth) {
        return [] as const
      }

      // Fetch direct children
      const childrenStream = retrieveChildrenStream({ blockId, pageSize })
      const children = yield* Stream.runCollect(childrenStream).pipe(
        Effect.map((chunk) => [...chunk]),
      )

      // For each child, recursively fetch its children if applicable
      const nodes = yield* Effect.forEach(
        children,
        (block) =>
          Effect.gen(function* () {
            let nodeChildren: BlockTree = []

            if (canHaveChildren({ block, skipTypes })) {
              nodeChildren = yield* fetchTreeRecursive({ blockId: block.id, depth: depth + 1 })
            }

            const node: BlockTreeNode = {
              block,
              children: nodeChildren,
            }
            return node
          }),
        { concurrency },
      )

      return nodes
    }).pipe(
      Effect.withSpan('NotionBlocks.fetchTreeRecursive', {
        attributes: {
          'notion.block_id': args.blockId,
          'notion.depth': args.depth,
        },
      }),
    )

  return fetchTreeRecursive({ blockId: opts.blockId, depth: 0 }).pipe(
    Effect.withSpan('NotionBlocks.retrieveAsTree', {
      attributes: { 'notion.block_id': opts.blockId },
    }),
  )
}

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Blocks API */
export const NotionBlocks = {
  retrieve,
  retrieveChildren,
  retrieveChildrenStream,
  append,
  update,
  delete: deleteBlock,
  /** Retrieve all nested blocks as a flat stream with depth info */
  retrieveAllNested,
  /** Retrieve all nested blocks as a tree structure */
  retrieveAsTree,
} as const
