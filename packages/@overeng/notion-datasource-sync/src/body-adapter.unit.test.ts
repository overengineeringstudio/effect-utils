import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyPointer,
  Hash,
  NotionRequestId,
  PageId,
  bodySafetySnapshot,
  evaluateBodyAdapterContract,
  makeFakePageBodySyncPort,
  type BodySafetySnapshot,
} from './mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)

const pageId = decode(PageId, 'page-1')
const requestId = decode(NotionRequestId, 'req-1')

const pointer = decode(BodyPointer, {
  _tag: 'BodyPointer',
  pageId,
  bodyHash: hash('a'),
  observedAt: '2026-05-25T00:00:00.000Z',
})

const fakePort = (safety: BodySafetySnapshot) =>
  makeFakePageBodySyncPort({
    pages: [
      {
        pageId,
        pointer,
        requestId,
        safety,
      },
    ],
  })

describe('body adapter contract', () => {
  it('turns body adapter surface leaks into named guard results', async () => {
    const safety = bodySafetySnapshot({
      adapterMutationSurfaces: [
        'body',
        'row-property',
        'schema',
        'title',
        'trash',
        'icon',
        'cover',
      ],
    })

    expect(evaluateBodyAdapterContract(safety)).toMatchObject({
      _tag: 'blocked',
      guard: 'BodyAdapterNonBodyMutation',
    })

    const result = await Effect.runPromise(
      fakePort(safety).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'BodyAdapterNonBodyMutation',
    })
  })

  it.each([
    ['truncated body', bodySafetySnapshot({ truncated: true }), 'BodyLossyRemote'],
    [
      'unknown block IDs with unknown cause',
      bodySafetySnapshot({ unknownBlockCause: 'unknown' }),
      'MarkdownUnknownBlocksAmbiguous',
    ],
    [
      'ambiguous markdown selection',
      bodySafetySnapshot({ selection: 'ambiguous' }),
      'MarkdownSelectionAmbiguous',
    ],
    [
      'child page/database deletion',
      bodySafetySnapshot({ wouldDeleteChildren: true }),
      'MarkdownWouldDeleteChildren',
    ],
    [
      'synced page unsupported',
      bodySafetySnapshot({ syncedPageUnsupported: true }),
      'MarkdownSyncedPageUnsupported',
    ],
  ])('blocks lossy or destructive body writes: %s', async (_name, safety, reason) => {
    const result = await Effect.runPromise(
      fakePort(safety).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason,
    })
  })

  it('reports stale body bases as body conflicts before push', async () => {
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer,
          requestId,
          remoteBodyHash: hash('c'),
        },
      ],
    })

    const result = await Effect.runPromise(
      port.planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'StaleSurfaceBase',
      remoteBodyHash: hash('c'),
    })
  })
})
