import type { HttpClientRequest } from '@effect/platform'
import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Block } from '@overeng/notion-effect-schema'

import type { BlockTree } from './blocks.ts'
import {
  NotionBody,
  NotionBodyObservationChangedError,
  observeFromSnapshots,
} from './body-observation.ts'
import { createTestLayer, type MockResponse } from './test/test-utils.ts'

const pageId = '00000000-0000-4000-8000-000000000020'
const blockId = '00000000-0000-4000-8000-000000000021'
const userId = '00000000-0000-4000-8000-000000000010'
const createdTime = '2026-06-09T00:00:00.000Z'

const block = (opts: {
  readonly id: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly hasChildren?: boolean
}): Block =>
  ({
    object: 'block',
    id: opts.id,
    parent: { type: 'page_id', page_id: '00000000-0000-4000-8000-000000000000' },
    type: opts.type,
    created_time: '2026-06-09T00:00:00.000Z',
    created_by: { object: 'user', id: userId },
    last_edited_time: '2026-06-09T00:00:00.000Z',
    last_edited_by: { object: 'user', id: userId },
    has_children: opts.hasChildren ?? false,
    in_trash: false,
    [opts.type]: opts.payload,
  }) as Block

const text = (content: string) => [
  {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
    href: null,
  },
]

type ObserveAttempt = {
  readonly beforeLastEditedTime: string
  readonly afterLastEditedTime: string
  readonly markdown: string
  readonly blockText: string
}

const pageResponse = (opts: { readonly lastEditedTime: string }) => ({
  object: 'page',
  id: pageId,
  created_time: createdTime,
  created_by: { object: 'user', id: userId },
  last_edited_time: opts.lastEditedTime,
  last_edited_by: { object: 'user', id: userId },
  icon: null,
  cover: null,
  parent: { type: 'workspace', workspace: true },
  in_trash: false,
  url: `https://www.notion.so/${pageId}`,
  public_url: null,
  properties: {},
})

const markdownResponse = (opts: { readonly markdown: string }) => ({
  object: 'page_markdown',
  markdown: opts.markdown,
  truncated: false,
  unknown_block_ids: [],
})

const blockChildrenResponse = (opts: { readonly blockText: string }) => ({
  object: 'list',
  results: [
    block({
      id: blockId,
      type: 'paragraph',
      payload: { rich_text: text(opts.blockText) },
    }),
  ],
  next_cursor: null,
  has_more: false,
})

const makeObserveTestLayer = (attempts: readonly ObserveAttempt[]) => {
  const requests: Array<{ readonly method: string; readonly path: string }> = []
  let pageCalls = 0
  let markdownCalls = 0
  let blockChildrenCalls = 0

  const attemptAt = (index: number): ObserveAttempt => {
    const attempt = attempts[index] ?? attempts[attempts.length - 1]
    if (attempt === undefined) {
      throw new Error('At least one observe attempt fixture is required')
    }
    return attempt
  }

  const layer = createTestLayer((request: HttpClientRequest.HttpClientRequest): MockResponse => {
    const url = new URL(request.url)
    requests.push({ method: request.method, path: `${url.pathname}${url.search}` })

    if (request.method === 'GET' && url.pathname === `/v1/pages/${pageId}`) {
      const attempt = attemptAt(Math.floor(pageCalls / 2))
      const lastEditedTime =
        pageCalls % 2 === 0 ? attempt.beforeLastEditedTime : attempt.afterLastEditedTime
      pageCalls += 1
      return { status: 200, body: pageResponse({ lastEditedTime }) }
    }

    if (request.method === 'GET' && url.pathname === `/v1/pages/${pageId}/markdown`) {
      const attempt = attemptAt(markdownCalls)
      markdownCalls += 1
      return { status: 200, body: markdownResponse({ markdown: attempt.markdown }) }
    }

    if (request.method === 'GET' && url.pathname === `/v1/blocks/${pageId}/children`) {
      const attempt = attemptAt(blockChildrenCalls)
      blockChildrenCalls += 1
      return { status: 200, body: blockChildrenResponse({ blockText: attempt.blockText }) }
    }

    return {
      status: 404,
      body: {
        object: 'error',
        status: 404,
        code: 'object_not_found',
        message: `Unexpected request ${request.method} ${url.pathname}${url.search}`,
      },
    }
  })

  return {
    layer,
    requests,
    counts: () => ({ pageCalls, markdownCalls, blockChildrenCalls }),
  }
}

describe('NotionBody.observeFromSnapshots', () => {
  it('classifies endpoint Markdown missing rendered content after a divider as lossy', async () => {
    const tree: BlockTree = [
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000001',
          type: 'paragraph',
          payload: { rich_text: text('Before') },
        }),
        children: [],
      },
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000002',
          type: 'divider',
          payload: {},
        }),
        children: [],
      },
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000003',
          type: 'paragraph',
          payload: { rich_text: text('After') },
        }),
        children: [],
      },
    ]

    const observed = await Effect.runPromise(
      observeFromSnapshots({
        pageId: '00000000-0000-4000-8000-000000000020',
        markdown: {
          object: 'page_markdown',
          markdown: 'Before\n\n---',
          truncated: false,
          unknown_block_ids: [],
        },
        tree,
      }),
    )

    expect(observed.completeness).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
    })
    expect(observed.inventory.entries.map((entry) => entry.type)).toEqual([
      'paragraph',
      'divider',
      'paragraph',
    ])
    expect(observed.evidence).toMatchObject({
      _tag: 'RemoteBodyObservationEvidence',
      schemaVersion: 1,
      pageId: '00000000-0000-4000-8000-000000000020',
      endpointMarkdown: {
        _tag: 'ContentDescriptor',
        mediaType: 'text/markdown; charset=utf-8',
        codec: 'notion-enhanced-markdown',
        schemaVersion: 1,
      },
      blockInventory: {
        _tag: 'ContentDescriptor',
        mediaType: 'application/json',
        codec: 'canonical-json',
        schemaVersion: 1,
      },
      completeness: 'lossy',
    })
    expect(observed.evidenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('changes evidence fingerprint for same rendered body with different endpoint evidence', async () => {
    const tree: BlockTree = [
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000001',
          type: 'paragraph',
          payload: { rich_text: text('Same body') },
        }),
        children: [],
      },
    ]

    const base = {
      pageId: '00000000-0000-4000-8000-000000000020',
      tree,
      observedAt: '2026-06-09T00:00:00.000Z',
      beforeLastEditedTime: '2026-06-09T00:00:00.000Z',
      afterLastEditedTime: '2026-06-09T00:00:00.000Z',
    } as const
    const left = await Effect.runPromise(
      observeFromSnapshots({
        ...base,
        markdown: {
          object: 'page_markdown',
          markdown: 'Same body',
          truncated: false,
          unknown_block_ids: [],
        },
      }),
    )
    const right = await Effect.runPromise(
      observeFromSnapshots({
        ...base,
        markdown: {
          object: 'page_markdown',
          markdown: 'Same body\n',
          truncated: false,
          unknown_block_ids: [],
        },
      }),
    )

    expect(left.inventory.renderedMarkdown).toBe(right.inventory.renderedMarkdown)
    expect(left.evidence.renderedBody.digest).toBe(right.evidence.renderedBody.digest)
    expect(left.evidenceFingerprint).not.toBe(right.evidenceFingerprint)
  })

  it('classifies endpoint Markdown missing heading children as lossy', async () => {
    const tree: BlockTree = [
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000004',
          type: 'heading_1',
          payload: { rich_text: text('Heading'), is_toggleable: true },
          hasChildren: true,
        }),
        children: [
          {
            block: block({
              id: '00000000-0000-4000-8000-000000000005',
              type: 'paragraph',
              payload: { rich_text: text('Nested child') },
            }),
            children: [],
          },
        ],
      },
    ]

    const observed = await Effect.runPromise(
      observeFromSnapshots({
        pageId: '00000000-0000-4000-8000-000000000020',
        markdown: {
          object: 'page_markdown',
          markdown: '# Heading',
          truncated: false,
          unknown_block_ids: [],
        },
        tree,
      }),
    )

    expect(observed.inventory.renderedMarkdown).toBe('# Heading\n\nNested child')
    expect(observed.completeness).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
    })
  })
})

describe('NotionBody.observe', () => {
  it('observes a stable metadata window through the HTTP test layer', async () => {
    const test = makeObserveTestLayer([
      {
        beforeLastEditedTime: '2026-06-09T00:00:00.000Z',
        afterLastEditedTime: '2026-06-09T00:00:00.000Z',
        markdown: 'Stable body',
        blockText: 'Stable body',
      },
    ])

    const observed = await Effect.runPromise(
      NotionBody.observe({ pageId }).pipe(Effect.provide(test.layer)),
    )

    expect(observed.pageId).toBe(pageId)
    expect(observed.markdown.markdown).toBe('Stable body')
    expect(observed.inventory.renderedMarkdown).toBe('Stable body')
    expect(observed.completeness).toEqual({ _tag: 'complete' })
    expect(test.requests).toEqual([
      { method: 'GET', path: `/v1/pages/${pageId}` },
      { method: 'GET', path: `/v1/pages/${pageId}/markdown` },
      { method: 'GET', path: `/v1/blocks/${pageId}/children?page_size=100` },
      { method: 'GET', path: `/v1/pages/${pageId}` },
    ])
  })

  it('retries changed metadata and returns the retry-attempt observation', async () => {
    const test = makeObserveTestLayer([
      {
        beforeLastEditedTime: '2026-06-09T00:00:00.000Z',
        afterLastEditedTime: '2026-06-09T00:00:01.000Z',
        markdown: 'First attempt body',
        blockText: 'First attempt body',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:01.000Z',
        afterLastEditedTime: '2026-06-09T00:00:01.000Z',
        markdown: 'Retry attempt body',
        blockText: 'Retry attempt body',
      },
    ])

    const observed = await Effect.runPromise(
      NotionBody.observe({ pageId }).pipe(Effect.provide(test.layer)),
    )

    expect(observed.markdown.markdown).toBe('Retry attempt body')
    expect(observed.inventory.renderedMarkdown).toBe('Retry attempt body')
    expect(test.counts()).toEqual({
      pageCalls: 4,
      markdownCalls: 2,
      blockChildrenCalls: 2,
    })
  })

  it('fails closed with a tagged error when all metadata windows change', async () => {
    const test = makeObserveTestLayer([
      {
        beforeLastEditedTime: '2026-06-09T00:00:00.000Z',
        afterLastEditedTime: '2026-06-09T00:00:01.000Z',
        markdown: 'Attempt 1',
        blockText: 'Attempt 1',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:01.000Z',
        afterLastEditedTime: '2026-06-09T00:00:02.000Z',
        markdown: 'Attempt 2',
        blockText: 'Attempt 2',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:02.000Z',
        afterLastEditedTime: '2026-06-09T00:00:03.000Z',
        markdown: 'Attempt 3',
        blockText: 'Attempt 3',
      },
    ])

    const result = await Effect.runPromise(
      Effect.either(NotionBody.observe({ pageId }).pipe(Effect.provide(test.layer))),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result) === true) {
      expect(result.left).toBeInstanceOf(NotionBodyObservationChangedError)
      expect(result.left).toMatchObject({
        _tag: 'NotionBodyObservationChangedError',
        pageId,
        attempts: 3,
        beforeLastEditedTime: '2026-06-09T00:00:02.000Z',
        afterLastEditedTime: '2026-06-09T00:00:03.000Z',
      })
      expect(result.left.message).toContain('all 3 observation attempts were unstable')
    }
  })

  it('bounds unstable observations to three full attempts', async () => {
    const test = makeObserveTestLayer([
      {
        beforeLastEditedTime: '2026-06-09T00:00:00.000Z',
        afterLastEditedTime: '2026-06-09T00:00:01.000Z',
        markdown: 'Attempt 1',
        blockText: 'Attempt 1',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:01.000Z',
        afterLastEditedTime: '2026-06-09T00:00:02.000Z',
        markdown: 'Attempt 2',
        blockText: 'Attempt 2',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:02.000Z',
        afterLastEditedTime: '2026-06-09T00:00:03.000Z',
        markdown: 'Attempt 3',
        blockText: 'Attempt 3',
      },
      {
        beforeLastEditedTime: '2026-06-09T00:00:03.000Z',
        afterLastEditedTime: '2026-06-09T00:00:03.000Z',
        markdown: 'Should not be observed',
        blockText: 'Should not be observed',
      },
    ])

    const result = await Effect.runPromise(
      Effect.either(NotionBody.observe({ pageId }).pipe(Effect.provide(test.layer))),
    )

    expect(Either.isLeft(result)).toBe(true)
    expect(test.counts()).toEqual({
      pageCalls: 6,
      markdownCalls: 3,
      blockChildrenCalls: 3,
    })
    expect(test.requests).toHaveLength(12)
  })
})
