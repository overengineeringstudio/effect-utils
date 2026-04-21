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
  /**
   * Install a failure hook that runs before each handled request. Return a
   * non-undefined value from the hook to throw (simulate an API error);
   * return undefined to proceed normally. Used by tests that exercise
   * mid-batch failure paths.
   */
  readonly failOn: (hook: (req: FakeRequest) => Error | undefined) => void
  /**
   * Install a file_upload_id rejection predicate. Any append/update request
   * whose payload references a matching id surfaces as a Notion-shaped
   * `validation_error` with HTTP 400, matching the production API's
   * response envelope for evicted / not-yet-usable uploads. Compose with
   * `failOn` if both are needed; this one fires inside `failOn`.
   */
  readonly rejectUploadIds: (predicate: (fileUploadId: string) => boolean) => void
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

/**
 * Mock-side sentinel that mirrors Notion's error envelope. Throwing one
 * inside `handle` surfaces to the HTTP layer as a real non-2xx response so
 * `parseErrorResponse` in notion-effect-client produces a proper
 * `NotionApiError` with `status` / `code` / `message` (instead of a
 * service-unavailable HttpClientError wrapping a stringified JS error).
 *
 * Tests asserting the archived-block idempotency contract depend on this
 * shape: the real API returns HTTP 400 with
 * `{ object: 'error', code: 'validation_error', message: "Can't edit block that is archived..." }`
 * and the sync driver's catch matches on `code === 'validation_error'` plus
 * the message body.
 */
export class FakeNotionResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FakeNotionResponseError'
  }
}

const respErr = (status: number, code: string, message: string): never => {
  throw new FakeNotionResponseError(status, code, message)
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

  let failureHook: ((req: FakeRequest) => Error | undefined) | undefined
  let uploadIdPredicate: ((fileUploadId: string) => boolean) | undefined

  /** Walk a nested block body collecting every `file_upload.id`. */
  const collectFileUploadIds = (body: unknown): string[] => {
    const out: string[] = []
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const rec = node as Record<string, unknown>
      const fu = rec.file_upload
      if (fu !== null && typeof fu === 'object') {
        const id = (fu as { id?: unknown }).id
        if (typeof id === 'string') out.push(id)
      }
      const children = rec.children
      if (Array.isArray(children)) {
        for (const c of children) walk(c)
      }
      // Scan every block body (type-keyed payload under e.g. `image`, `video`).
      for (const [k, v] of Object.entries(rec)) {
        if (k === 'children' || k === 'file_upload') continue
        if (v !== null && typeof v === 'object') walk(v)
      }
    }
    walk(body)
    return out
  }

  const handle = (req: HttpClientRequest.HttpClientRequest, body: unknown): unknown => {
    const url = new URL(req.url)
    const path = url.pathname
    const fakeReq: FakeRequest = { method: req.method, path, body }
    requests.push(fakeReq)

    if (failureHook !== undefined) {
      const err = failureHook(fakeReq)
      if (err !== undefined) throw err
    }

    if (uploadIdPredicate !== undefined && (req.method === 'POST' || req.method === 'PATCH')) {
      const ids = collectFileUploadIds(body)
      const rejected = ids.find((id) => uploadIdPredicate!(id))
      if (rejected !== undefined) {
        respErr(
          400,
          'validation_error',
          `Invalid file_upload. The file_upload with ID ${rejected} is expired or no longer usable.`,
        )
      }
    }

    const appendChildrenMatch = path.match(/^\/v1\/blocks\/([^/]+)\/children$/)
    const blockOpMatch = path.match(/^\/v1\/blocks\/([^/]+)$/)

    if (appendChildrenMatch !== null && (req.method === 'POST' || req.method === 'PATCH')) {
      const parent = appendChildrenMatch[1]!
      const b = body as {
        children: { type: string; [k: string]: unknown }[]
        position?:
          | { type: 'after_block'; after_block: { id: string } }
          | { type: 'start' }
          | { type: 'end' }
      }
      // Notion validation: column_list and column require non-empty children
      // inlined in the same request. Staged-append (create shell, then
      // append descendants) is rejected by the real API with
      // `validation_error`; mirror that here so drivers that naively emit
      // one-op-per-block fail the same way against the fake.
      //
      // Additional cap: every nested `children` array (including the
      // top-level batch) must have length ≤ 100. Mirrors Notion's
      // `body.children[N].table.children.length should be ≤ 100` and the
      // equivalent validation on the top-level `children` param.
      // Ref: https://developers.notion.com/reference/patch-block-children
      const MAX_CHILDREN = 100
      if (b.children.length > MAX_CHILDREN) {
        throw new Error(
          `fake-notion: body.children.length should be ≤ ${MAX_CHILDREN}, instead was ${b.children.length} (validation_error)`,
        )
      }
      const validateAtomic = (child: { type: string; [k: string]: unknown }): void => {
        // Enforce the ≤100 cap on every container's nested children array.
        const nestedPayload = child[child.type] as { children?: unknown[] } | undefined
        const nestedChildren = nestedPayload?.children
        if (nestedChildren !== undefined && nestedChildren.length > MAX_CHILDREN) {
          throw new Error(
            `fake-notion: body.children[N].${child.type}.children.length should be ≤ ${MAX_CHILDREN}, instead was ${nestedChildren.length} (validation_error)`,
          )
        }
        if (child.type === 'column_list') {
          const cl = child.column_list as { children?: unknown[] } | undefined
          if (cl?.children === undefined || cl.children.length < 2) {
            throw new Error(
              `fake-notion: column_list must be created with >=2 nested column children in the same request (validation_error)`,
            )
          }
          for (const col of cl.children as { type: string }[]) validateAtomic(col)
        }
        if (child.type === 'column') {
          const co = child.column as { children?: unknown[] } | undefined
          if (co?.children === undefined || co.children.length < 1) {
            throw new Error(
              `fake-notion: column must be created with >=1 nested child in the same request (validation_error)`,
            )
          }
          for (const nested of co.children as { type: string; [k: string]: unknown }[]) {
            validateAtomic(nested)
          }
        }
        if (child.type === 'table') {
          // Notion rejects `table` creates without nested `table_row` children
          // inlined — same contract as column_list. Error surfaces as
          // `body.children[n].table.children should be defined`.
          const tb = child.table as { children?: unknown[] } | undefined
          if (tb?.children === undefined || tb.children.length < 1) {
            throw new Error(
              `fake-notion: table must be created with >=1 nested table_row child in the same request (validation_error)`,
            )
          }
          for (const row of tb.children as { type: string; [k: string]: unknown }[]) {
            validateAtomic(row)
          }
        }
      }
      for (const child of b.children) validateAtomic(child)
      const list = getChildList(parent)
      const mintNested = (
        child: { type: string; [k: string]: unknown },
        parentId: string,
      ): FakeBlock => {
        const payload = (child[child.type] as Record<string, unknown>) ?? {}
        const { children: nestedChildren, ...rest } = payload as {
          children?: { type: string; [k: string]: unknown }[]
        } & Record<string, unknown>
        const nb: FakeBlock = {
          id: mintId(),
          type: child.type,
          parent: parentId,
          payload: rest,
          archived: false,
          children: [],
        }
        blocks.set(nb.id, nb)
        if (nestedChildren !== undefined) {
          for (const c of nestedChildren) {
            const child2 = mintNested(c, nb.id)
            nb.children.push(child2.id)
          }
        }
        return nb
      }
      const newBlocks: FakeBlock[] = b.children.map((child) => mintNested(child, parent))

      let insertAt = list.length
      if (b.position?.type === 'after_block') {
        const afterId = b.position.after_block.id
        const idx = list.indexOf(afterId)
        insertAt = idx >= 0 ? idx + 1 : list.length
      } else if (b.position?.type === 'start') {
        insertAt = 0
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
      if (b === undefined) {
        respErr(404, 'object_not_found', `Could not find block with ID: ${id}.`)
      }
      // Mirror Notion: edits against archived blocks are rejected with a
      // validation_error. Dogfood v4/v5 tripped this when a poisoned cache
      // re-issued archives against already-archived blocks. The sync driver
      // now catches this shape and treats it as idempotent success on
      // delete; update still propagates it as a hard failure.
      if (b!.archived) {
        respErr(
          400,
          'validation_error',
          "Can't edit block that is archived. You must unarchive the block before editing.",
        )
      }
      const patch = body as Record<string, unknown>
      const typePatch = patch[b!.type] as Record<string, unknown> | undefined
      if (typePatch !== undefined) b!.payload = { ...b!.payload, ...typePatch }
      return toBlockResponse(b!, b!.parent)
    }

    if (blockOpMatch !== null && req.method === 'DELETE') {
      const id = blockOpMatch[1]!
      const b = blocks.get(id)
      if (b === undefined) {
        respErr(404, 'object_not_found', `Could not find block with ID: ${id}.`)
      }
      if (b!.archived) {
        respErr(
          400,
          'validation_error',
          "Can't edit block that is archived. You must unarchive the block before editing.",
        )
      }
      b!.archived = true
      const parentList = getChildList(b!.parent)
      const idx = parentList.indexOf(id)
      if (idx >= 0) parentList.splice(idx, 1)
      return toBlockResponse(b!, b!.parent)
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
      try {
        const responseBody = handle(request, parsed)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      } catch (err) {
        if (err instanceof FakeNotionResponseError) {
          // Emit the real Notion error envelope so the client's
          // `parseErrorResponse` decodes a proper `NotionApiError` with the
          // right `status` / `code` / `message` — the shape sync's
          // idempotency guard matches on.
          const body = {
            object: 'error' as const,
            status: err.status,
            code: err.code,
            message: err.message,
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: err.status,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        throw err
      }
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
    failOn: (hook) => {
      failureHook = hook
    },
    rejectUploadIds: (predicate) => {
      uploadIdPredicate = predicate
    },
  }
}
