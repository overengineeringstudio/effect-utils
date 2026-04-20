import { HttpClient, type HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'

import { NotionConfig } from '@overeng/notion-effect-client'

/**
 * In-memory Notion API stub for driver-level tests.
 *
 * Implements just enough of the blocks endpoint for `sync()` to drive a full
 * mutation cycle without network:
 *   - POST   /v1/blocks/{id}/children  (append; optional after_block)
 *   - PATCH  /v1/blocks/{id}           (update)
 *   - DELETE /v1/blocks/{id}           (archive)
 *   - GET    /v1/blocks/{id}/children  (list — unused by sync, but stubbed)
 *
 * Tests can inspect `requests` (the full request log) or `blocks` (the
 * simulated server state) after a sync.
 */
export interface FakeNotion {
  readonly layer: Layer.Layer<HttpClient.HttpClient | NotionConfig>
  readonly blocks: ReadonlyMap<string, FakeBlock>
  readonly requests: readonly FakeRequest[]
  /** Tree rooted at `pageId` built from the live `blocks` map. */
  readonly childrenOf: (parentId: string) => readonly FakeBlock[]
}

export interface FakeBlock {
  readonly id: string
  readonly type: string
  readonly parent: string
  payload: Record<string, unknown>
  archived: boolean
  /** Ordered child ids. */
  children: string[]
}

export interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

const FAKE_USER_ID = '00000000-0000-4000-8000-00000000beef'
const FAKE_USER = { object: 'user', id: FAKE_USER_ID } as const

/** Build a Notion-compliant Block envelope around a FakeBlock. */
const toBlockResponse = (b: FakeBlock, rootId: string): Record<string, unknown> => {
  const now = new Date().toISOString()
  const parentRef =
    b.parent === rootId || !b.parent.startsWith('fake-block-')
      ? { type: 'page_id' as const, page_id: b.parent }
      : { type: 'block_id' as const, block_id: b.parent }
  return {
    object: 'block',
    id: b.id,
    parent: parentRef,
    type: b.type,
    [b.type]: b.payload,
    created_time: now,
    created_by: FAKE_USER,
    last_edited_time: now,
    last_edited_by: FAKE_USER,
    has_children: b.children.length > 0,
    in_trash: b.archived,
  }
}

export const createFakeNotion = (): FakeNotion => {
  const blocks = new Map<string, FakeBlock>()
  const requests: FakeRequest[] = []
  let nextId = 1
  // Notion UUIDs are just strings schema-wise, but we keep them UUID-shaped so
  // they round-trip through any format checks downstream.
  const mintId = (): string => {
    const n = (nextId++).toString(16).padStart(12, '0')
    return `11111111-1111-4111-8111-${n}`
  }

  const childrenOf = (parentId: string): readonly FakeBlock[] => {
    const parent = blocks.get(parentId)
    const ids =
      parent !== undefined
        ? parent.children
        : // The rootId (pageId) itself isn't in `blocks`; track a root list
          // via blocks[''] entry seeded lazily.
          (blocks.get(parentId)?.children ?? rootChildrenByPage.get(parentId) ?? [])
    return ids.map((id) => blocks.get(id)!).filter((b) => !b.archived)
  }

  /** Root pages aren't in `blocks` — track their child lists separately. */
  const rootChildrenByPage = new Map<string, string[]>()
  const getChildList = (parentId: string): string[] => {
    const b = blocks.get(parentId)
    if (b !== undefined) return b.children
    let list = rootChildrenByPage.get(parentId)
    if (list === undefined) {
      list = []
      rootChildrenByPage.set(parentId, list)
    }
    return list
  }

  const handle = (req: HttpClientRequest.HttpClientRequest, body: unknown): unknown => {
    const url = new URL(req.url)
    const path = url.pathname
    requests.push({ method: req.method, path, body })

    const appendChildrenMatch = path.match(/^\/v1\/blocks\/([^/]+)\/children$/)
    const blockOpMatch = path.match(/^\/v1\/blocks\/([^/]+)$/)

    if (appendChildrenMatch !== null && (req.method === 'POST' || req.method === 'PATCH')) {
      const parent = appendChildrenMatch[1]!
      const b = body as {
        children: { type: string; [k: string]: unknown }[]
        position?: { type: 'after_block'; after_block: { id: string } }
      }
      const list = getChildList(parent)
      const newBlocks: FakeBlock[] = b.children.map((child) => ({
        id: mintId(),
        type: child.type,
        parent,
        payload: (child[child.type] as Record<string, unknown>) ?? {},
        archived: false,
        children: [],
      }))
      for (const nb of newBlocks) blocks.set(nb.id, nb)

      let insertAt = list.length
      if (b.position?.type === 'after_block') {
        const afterId = b.position.after_block.id
        const idx = list.indexOf(afterId)
        insertAt = idx >= 0 ? idx + 1 : list.length
      }
      list.splice(insertAt, 0, ...newBlocks.map((nb) => nb.id))

      return {
        object: 'list',
        results: newBlocks.map((nb) => toBlockResponse(nb, parent)),
      }
    }

    if (appendChildrenMatch !== null && req.method === 'GET') {
      const parent = appendChildrenMatch[1]!
      return {
        object: 'list',
        results: childrenOf(parent).map((b) => toBlockResponse(b, parent)),
        has_more: false,
        next_cursor: null,
      }
    }

    if (blockOpMatch !== null && req.method === 'PATCH') {
      const id = blockOpMatch[1]!
      const b = blocks.get(id)
      if (b === undefined) throw new Error(`fake-notion: unknown block ${id}`)
      const patch = body as Record<string, unknown>
      const typePatch = patch[b.type] as Record<string, unknown> | undefined
      if (typePatch !== undefined) b.payload = { ...b.payload, ...typePatch }
      return toBlockResponse(b, b.parent)
    }

    if (blockOpMatch !== null && req.method === 'DELETE') {
      const id = blockOpMatch[1]!
      const b = blocks.get(id)
      if (b === undefined) throw new Error(`fake-notion: unknown block ${id}`)
      b.archived = true
      const parentList = getChildList(b.parent)
      const idx = parentList.indexOf(id)
      if (idx >= 0) parentList.splice(idx, 1)
      return toBlockResponse(b, b.parent)
    }

    throw new Error(`fake-notion: unhandled ${req.method} ${path}`)
  }

  const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): unknown => {
    const tag = (body as { _tag?: string })._tag
    if (tag === 'Uint8Array') {
      const bytes = (body as { body: Uint8Array }).body
      const text = new TextDecoder().decode(bytes)
      if (text.length === 0) return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    if (tag === 'Raw') return (body as { body: unknown }).body
    return undefined
  }

  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const parsed = decodeBody(request.body)
      const responseBody = handle(request, parsed)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )

  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(NotionConfig, {
      authToken: Redacted.make('fake-token'),
      retryEnabled: false,
    }),
  )

  return {
    layer,
    get blocks() {
      return blocks
    },
    get requests() {
      return requests
    },
    childrenOf: (id) => childrenOf(id),
  }
}
