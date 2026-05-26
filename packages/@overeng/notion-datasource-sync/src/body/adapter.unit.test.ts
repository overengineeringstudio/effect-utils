import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyPointer,
  CommandId,
  DataSourceId,
  Hash,
  NotionRequestId,
  PageId,
  RowObserved,
  bodySafetySnapshot,
  evaluateBodyAdapterContract,
  makeFakePageBodySyncPort,
  makeUnsupportedPageBodySyncPort,
  type BodySafetySnapshot,
} from '../mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)

const commandId = (value: string) => decode(CommandId, value)
const pageId = decode(PageId, 'page-1')
const dataSourceId = decode(DataSourceId, 'data-source-1')
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
  it.each([
    ['unknown', 'MarkdownUnknownBlocksAmbiguous'],
    ['permission', 'MarkdownUnknownBlocksAmbiguous'],
    ['unsupported', 'MarkdownUnknownBlocksAmbiguous'],
    ['truncation', 'BodyLossyRemote'],
  ] as const)('fails closed for unknown-block cause: %s', (unknownBlockCause, guard) => {
    expect(evaluateBodyAdapterContract(bodySafetySnapshot({ unknownBlockCause }))).toMatchObject({
      _tag: 'blocked',
      guard,
    })
  })

  it('guards inconsistent truncation cause even when the truncated flag is absent', () => {
    expect(
      evaluateBodyAdapterContract(
        bodySafetySnapshot({
          truncated: false,
          unknownBlockCause: 'truncation',
        }),
      ),
    ).toMatchObject({
      _tag: 'blocked',
      guard: 'BodyLossyRemote',
    })
  })

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

  it('rejects queued body pushes whose base pointer is stale after current body changes', async () => {
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer,
          requestId,
        },
      ],
    })

    await expect(
      Effect.runPromise(
        port.push({
          _tag: 'BodyPushCommand',
          commandId: commandId('cmd-1'),
          pageId,
          baseBodyPointer: pointer,
          nextBodyHash: hash('b'),
        }),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodyPushResult',
      bodyPointer: {
        bodyHash: hash('b'),
      },
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.push({
            _tag: 'BodyPushCommand',
            commandId: commandId('cmd-2'),
            pageId,
            baseBodyPointer: pointer,
            nextBodyHash: hash('c'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'push',
      message: expect.stringContaining('StaleSurfaceBase'),
    })
  })

  it('uses observed body pointer safety metadata as the guard source', async () => {
    const safety = bodySafetySnapshot({ unknownBlockCause: 'permission' })
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer: {
            ...pointer,
            safety,
          },
          requestId,
        },
      ],
    })

    const observed = await Effect.runPromise(
      port.observe({
        _tag: 'ObserveBodyInput',
        pageId,
      }),
    )

    expect(observed.safety).toEqual(safety)
    expect(evaluateBodyAdapterContract(observed.safety ?? bodySafetySnapshot())).toMatchObject({
      _tag: 'blocked',
      guard: 'MarkdownUnknownBlocksAmbiguous',
    })
  })

  it('guards unsafe base pointer safety at the composition boundary', async () => {
    const unsafePointer = {
      ...pointer,
      safety: bodySafetySnapshot({ truncated: true }),
    }

    const result = await Effect.runPromise(
      fakePort(bodySafetySnapshot()).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: unsafePointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'BodyLossyRemote',
      baseBodyPointer: {
        safety: unsafePointer.safety,
      },
    })
  })

  it('fails closed when no concrete NotionMD body adapter is configured', async () => {
    const port = makeUnsupportedPageBodySyncPort()

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.observe({
            _tag: 'ObserveBodyInput',
            pageId,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'observe',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.push({
            _tag: 'BodyPushCommand',
            commandId: commandId('cmd-unsupported'),
            pageId,
            baseBodyPointer: pointer,
            nextBodyHash: hash('b'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'push',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.planLocalChange({
            _tag: 'BodyLocalChangeInput',
            pageId,
            baseBodyPointer: pointer,
            localBodyHash: hash('b'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'planLocalChange',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.repair({
            _tag: 'BodyRepairInput',
            pageId,
            currentBodyPointer: pointer,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'repair',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })
  })

  it('keeps replayed row body pointer safety usable for guards', () => {
    const safety = bodySafetySnapshot({ syncedPageUnsupported: true })
    const event = decode(RowObserved, {
      _tag: 'RowObserved',
      eventId: 'event-1',
      rootId: 'root-1',
      sequence: '1',
      codecVersion: 'v1',
      family: 'RemoteObserved',
      eventType: 'RowObserved',
      idempotencyKey: 'idem-1',
      surface: null,
      causedByEventIds: [],
      payloadHash: hash('d'),
      payload: {
        _tag: 'VersionedJson',
        codecVersion: 'v1',
        canonicalJson: '{}',
      },
      observedAt: '2026-05-25T00:00:00.000Z',
      dataSourceId,
      pageId,
      propertiesHash: hash('e'),
      bodyPointer: {
        _tag: 'BodyPointer',
        pageId,
        bodyHash: hash('a'),
        observedAt: '2026-05-25T00:00:00.000Z',
        safety,
      },
      inTrash: false,
    })

    expect(event.bodyPointer?.safety).toEqual(safety)
    expect(
      evaluateBodyAdapterContract(event.bodyPointer?.safety ?? bodySafetySnapshot()),
    ).toMatchObject({
      _tag: 'blocked',
      guard: 'MarkdownSyncedPageUnsupported',
    })
  })
})
