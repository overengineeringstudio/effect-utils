import { Effect, Layer } from 'effect'

import type {
  BodyConflict,
  BodyConflictReason,
  BodyIntent,
  BodyLocalChangeInput,
  BodyPushCommand,
  BodyPushResult,
  BodyRepairInput,
  ObserveBodyInput,
} from '../core/commands.ts'
import type {
  BodyPointer,
  BodySafetySnapshot,
  Hash,
  NotionRequestId,
  PageId,
} from '../core/domain.ts'
import { BodySyncError } from '../core/errors.ts'
import { guardBodySafety, type BodyAdapterMutationSurface, type GuardName } from '../core/guards.ts'
import { PageBodySyncPort, type PageBodySyncPortShape } from '../core/ports.ts'

export const bodySafetySnapshot = (
  overrides: Partial<BodySafetySnapshot> = {},
): BodySafetySnapshot => ({
  truncated: false,
  unknownBlockCause: undefined,
  selection: 'safe',
  wouldDeleteChildren: false,
  syncedPageUnsupported: false,
  adapterConflict: false,
  adapterMutationSurfaces: ['body'],
  ...overrides,
})

export type BodyAdapterContractResult =
  | {
      readonly _tag: 'body-only'
      readonly safety: BodySafetySnapshot
    }
  | {
      readonly _tag: 'blocked'
      readonly guard: BodyConflictReason
      readonly message: string
      readonly safety: BodySafetySnapshot
    }

const bodyConflictReasons = new Set<GuardName>([
  'StaleSurfaceBase',
  'BodyLossyRemote',
  'MarkdownUnknownBlocksAmbiguous',
  'MarkdownSelectionAmbiguous',
  'MarkdownWouldDeleteChildren',
  'MarkdownSyncedPageUnsupported',
  'BodyAdapterConflict',
  'BodyAdapterNonBodyMutation',
])

const toBodyConflictReason = (guard: GuardName): BodyConflictReason =>
  bodyConflictReasons.has(guard) === true ? (guard as BodyConflictReason) : 'BodyAdapterConflict'

export const evaluateBodyAdapterContract = (
  safety: BodySafetySnapshot,
): BodyAdapterContractResult => {
  const decision = guardBodySafety(safety)
  return decision._tag === 'allowed'
    ? { _tag: 'body-only', safety }
    : {
        _tag: 'blocked',
        guard: toBodyConflictReason(decision.guard),
        message: decision.message,
        safety,
      }
}

export type FakeBodyPageState = {
  readonly pageId: PageId
  readonly pointer: BodyPointer
  readonly requestId: NotionRequestId
  readonly safety?: BodySafetySnapshot
  readonly remoteBodyHash?: Hash
}

export type FakePageBodySyncPortInput = {
  readonly pages: ReadonlyArray<FakeBodyPageState>
}

const findPage = ({
  pages,
  operation,
  pageId,
}: {
  readonly pages: ReadonlyMap<PageId, FakeBodyPageState>
  readonly operation: string
  readonly pageId: PageId
}) =>
  Effect.fromNullable(pages.get(pageId)).pipe(
    Effect.mapError(
      () =>
        new BodySyncError({
          operation,
          pageId,
          message: `No fake body state for page ${pageId}`,
        }),
    ),
  )

const conflictFromBlocked = ({
  page,
  input,
  guard,
  message,
}: {
  readonly page: FakeBodyPageState
  readonly input: BodyLocalChangeInput | BodyRepairInput
  readonly guard: BodyConflictReason
  readonly message: string
}): BodyConflict => ({
  _tag: 'BodyConflict',
  pageId: input.pageId,
  baseBodyPointer: 'baseBodyPointer' in input ? input.baseBodyPointer : input.currentBodyPointer,
  localBodyHash: 'localBodyHash' in input ? input.localBodyHash : input.currentBodyPointer.bodyHash,
  remoteBodyHash: page.remoteBodyHash ?? page.pointer.bodyHash,
  reason: guard,
  message,
})

const safetyForPage = (page: FakeBodyPageState): BodySafetySnapshot =>
  page.pointer.safety ?? page.safety ?? bodySafetySnapshot()

const pointerWithSafety = ({
  pointer,
  safety = pointer.safety ?? bodySafetySnapshot(),
}: {
  readonly pointer: BodyPointer
  readonly safety?: BodySafetySnapshot
}): BodyPointer => ({
  ...pointer,
  safety,
})

const conflictFromPointer = ({
  pageId,
  pointer,
  localBodyHash,
  guard,
  message,
}: {
  readonly pageId: PageId
  readonly pointer: BodyPointer
  readonly localBodyHash: Hash
  readonly guard: BodyConflictReason
  readonly message: string
}): BodyConflict => ({
  _tag: 'BodyConflict',
  pageId,
  baseBodyPointer: pointer,
  localBodyHash,
  remoteBodyHash: pointer.bodyHash,
  reason: guard,
  message,
})

export const withBodyAdapterContract = (port: PageBodySyncPortShape): PageBodySyncPortShape => ({
  observe: (input) =>
    port
      .observe(input)
      .pipe(
        Effect.map((pointer) => pointerWithSafety({ pointer, safety: pointer.safety ?? bodySafetySnapshot() })),
      ),
  planLocalChange: (input) => {
    const safety = input.baseBodyPointer.safety ?? bodySafetySnapshot()
    const contract = evaluateBodyAdapterContract(safety)
    if (contract._tag === 'blocked') {
      return Effect.succeed(
        conflictFromPointer({
          pageId: input.pageId,
          pointer: pointerWithSafety({ pointer: input.baseBodyPointer, safety }),
          localBodyHash: input.localBodyHash,
          guard: contract.guard,
          message: contract.message,
        }),
      )
    }

    return port.planLocalChange({
      ...input,
      baseBodyPointer: pointerWithSafety({ pointer: input.baseBodyPointer, safety }),
    })
  },
  push: (command) => {
    const safety = command.baseBodyPointer.safety ?? bodySafetySnapshot()
    const contract = evaluateBodyAdapterContract(safety)
    if (contract._tag === 'blocked') {
      return Effect.fail(
        new BodySyncError({
          operation: 'push',
          pageId: command.pageId,
          message: `${contract.guard}: ${contract.message}`,
        }),
      )
    }

    return port.push({
      ...command,
      baseBodyPointer: pointerWithSafety({ pointer: command.baseBodyPointer, safety }),
    })
  },
  repair: (input) => {
    const safety = input.currentBodyPointer.safety ?? bodySafetySnapshot()
    const contract = evaluateBodyAdapterContract(safety)
    if (contract._tag === 'blocked') {
      return Effect.succeed(
        conflictFromPointer({
          pageId: input.pageId,
          pointer: pointerWithSafety({ pointer: input.currentBodyPointer, safety }),
          localBodyHash: input.currentBodyPointer.bodyHash,
          guard: contract.guard,
          message: contract.message,
        }),
      )
    }

    return port.repair({
      ...input,
      currentBodyPointer: pointerWithSafety({ pointer: input.currentBodyPointer, safety }),
    })
  },
})

export const makeUnsupportedPageBodySyncPort = ({
  message = 'No NotionMD page body adapter is configured',
}: {
  readonly message?: string
} = {}): PageBodySyncPortShape => {
  const fail = ({ operation, pageId }: { readonly operation: string; readonly pageId: PageId }) =>
    Effect.fail(new BodySyncError({ operation, pageId, message }))

  return {
    observe: (input) => fail({ operation: 'observe', pageId: input.pageId }),
    planLocalChange: (input) => fail({ operation: 'planLocalChange', pageId: input.pageId }),
    push: (command) => fail({ operation: 'push', pageId: command.pageId }),
    repair: (input) => fail({ operation: 'repair', pageId: input.pageId }),
  }
}

export const makeFakePageBodySyncPort = ({
  pages,
}: FakePageBodySyncPortInput): PageBodySyncPortShape => {
  const byPageId = new Map<PageId, FakeBodyPageState>(
    pages.map((page) => {
      const safety = safetyForPage(page)
      return [
        page.pageId,
        {
          ...page,
          pointer: pointerWithSafety({ pointer: page.pointer, safety }),
          safety,
        },
      ]
    }),
  )

  return withBodyAdapterContract({
    observe: (input: ObserveBodyInput) =>
      findPage({ pages: byPageId, operation: 'observe', pageId: input.pageId }).pipe(
        Effect.map((page) => pointerWithSafety({ pointer: page.pointer, safety: safetyForPage(page) })),
      ),
    planLocalChange: (input: BodyLocalChangeInput) =>
      findPage({ pages: byPageId, operation: 'planLocalChange', pageId: input.pageId }).pipe(
        Effect.map((page): BodyIntent | BodyConflict => {
          const contract = evaluateBodyAdapterContract(safetyForPage(page))
          if (contract._tag === 'blocked') {
            return conflictFromBlocked({
              page,
              input,
              guard: contract.guard,
              message: contract.message,
            })
          }

          const remoteBodyHash = page.remoteBodyHash ?? page.pointer.bodyHash
          if (input.baseBodyPointer.bodyHash !== remoteBodyHash) {
            return conflictFromBlocked({
              page,
              input,
              guard: 'StaleSurfaceBase',
              message: 'Local body base does not match the current remote body hash',
            })
          }

          return {
            _tag: 'BodyIntent',
            pageId: input.pageId,
            baseBodyPointer: input.baseBodyPointer,
            nextBodyHash: input.localBodyHash,
            ...(input.localBodyPath === undefined ? {} : { localBodyPath: input.localBodyPath }),
            ...(input.localBodyContent === undefined
              ? {}
              : { localBodyContent: input.localBodyContent }),
          }
        }),
      ),
    push: (command: BodyPushCommand) =>
      findPage({ pages: byPageId, operation: 'push', pageId: command.pageId }).pipe(
        Effect.flatMap((page) => {
          const safety = safetyForPage(page)
          const contract = evaluateBodyAdapterContract(safety)
          if (contract._tag === 'blocked') {
            return Effect.fail(
              new BodySyncError({
                operation: 'push',
                pageId: command.pageId,
                message: `${contract.guard}: ${contract.message}`,
              }),
            )
          }

          const remoteBodyHash = page.remoteBodyHash ?? page.pointer.bodyHash
          if (command.baseBodyPointer.bodyHash !== remoteBodyHash) {
            return Effect.fail(
              new BodySyncError({
                operation: 'push',
                pageId: command.pageId,
                message: 'StaleSurfaceBase: queued body command base does not match current body',
              }),
            )
          }

          const bodyPointer = pointerWithSafety({
            pointer: {
              _tag: 'BodyPointer',
              pageId: command.pageId,
              bodyHash: command.nextBodyHash,
              observedAt: page.pointer.observedAt,
            },
            safety,
          })
          byPageId.set(command.pageId, {
            ...page,
            pointer: bodyPointer,
            remoteBodyHash: command.nextBodyHash,
            safety,
          })

          const result: BodyPushResult = {
            _tag: 'BodyPushResult',
            pageId: command.pageId,
            requestId: page.requestId,
            bodyPointer,
          }
          return Effect.succeed(result)
        }),
      ),
    repair: (input: BodyRepairInput) =>
      findPage({ pages: byPageId, operation: 'repair', pageId: input.pageId }).pipe(
        Effect.map((page): BodyPointer | BodyConflict => {
          const contract = evaluateBodyAdapterContract(safetyForPage(page))
          return contract._tag === 'blocked'
            ? conflictFromBlocked({ page, input, guard: contract.guard, message: contract.message })
            : pointerWithSafety({ pointer: page.pointer, safety: safetyForPage(page) })
        }),
      ),
  })
}

export const fakePageBodySyncPortLayer = (input: FakePageBodySyncPortInput) =>
  Layer.succeed(PageBodySyncPort, makeFakePageBodySyncPort(input))

export const bodyOnlyMutationSurfaces = (
  mutationSurfaces: ReadonlyArray<BodyAdapterMutationSurface>,
) => bodySafetySnapshot({ adapterMutationSurfaces: mutationSurfaces })
