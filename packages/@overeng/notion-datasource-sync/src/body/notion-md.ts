import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, Layer, Schema, Stream } from 'effect'

import {
  NotionMdGateway,
  NmdStateStore,
  parseNmdFile,
  pullPage,
  type NotionMdGatewayShape,
  type NmdStateStoreShape,
} from '@overeng/notion-md'

import type { BodyLocalChangeInput, BodyRepairInput, ObserveBodyInput } from '../core/commands.ts'
import {
  BodyPointer,
  Hash,
  NotionRequestId,
  type AbsolutePath,
  type PageId,
} from '../core/domain.ts'
import { BodySyncError, LocalStoreError } from '../core/errors.ts'
import {
  LocalWorkspacePort,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import {
  bodySafetySnapshot,
  evaluateBodyAdapterContract,
  withBodyAdapterContract,
} from './adapter.ts'
import {
  filesystemWorkspacePageSidecarPath,
  makeFilesystemLocalWorkspacePort,
  ownWriteSuppressionToken,
  type FilesystemWorkspaceSidecar,
} from '../local/workspace.ts'

export type NotionMdPageBodySyncPortInput = {
  readonly gateway: NotionMdGatewayShape
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const sha256Hash = (value: string): Hash =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(value).digest('hex')}` })

const observedAtNow = () => decode({ schema: Schema.DateTimeUtc, value: new Date().toISOString() })

const bodyPointerFromMarkdown = (input: {
  readonly pageId: PageId
  readonly markdown: string
  readonly truncated: boolean
  readonly unknownBlockIds: readonly string[]
}): typeof BodyPointer.Type => {
  const unknownBlockCause =
    input.truncated === true
      ? 'truncation'
      : input.unknownBlockIds.length > 0
        ? 'unknown'
        : undefined

  return BodyPointer.make({
    _tag: 'BodyPointer',
    pageId: input.pageId,
    bodyHash: sha256Hash(input.markdown),
    observedAt: observedAtNow(),
    safety: bodySafetySnapshot({
      truncated: input.truncated,
      unknownBlockCause,
      adapterMutationSurfaces: ['body'],
    }),
  })
}

export const makeNotionMdPageBodySyncPort = ({
  gateway,
}: NotionMdPageBodySyncPortInput): PageBodySyncPortShape =>
  withBodyAdapterContract({
    observe: (input: ObserveBodyInput) =>
      gateway.pullPage({ pageId: input.pageId }).pipe(
        Effect.map((page) =>
          bodyPointerFromMarkdown({
            pageId: input.pageId,
            markdown: page.markdown.markdown,
            truncated: page.markdown.truncated,
            unknownBlockIds: page.markdown.unknown_block_ids,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new BodySyncError({
              operation: 'observe',
              pageId: input.pageId,
              message: 'Failed to observe NotionMD page body',
              cause,
            }),
        ),
      ),
    planLocalChange: (input: BodyLocalChangeInput) =>
      gateway.pullPage({ pageId: input.pageId }).pipe(
        Effect.map((page) => {
          const remote = bodyPointerFromMarkdown({
            pageId: input.pageId,
            markdown: page.markdown.markdown,
            truncated: page.markdown.truncated,
            unknownBlockIds: page.markdown.unknown_block_ids,
          })
          const contract = evaluateBodyAdapterContract(remote.safety ?? bodySafetySnapshot())

          if (contract._tag === 'blocked') {
            return {
              _tag: 'BodyConflict' as const,
              pageId: input.pageId,
              baseBodyPointer: input.baseBodyPointer,
              localBodyHash: input.localBodyHash,
              remoteBodyHash: remote.bodyHash,
              reason: contract.guard,
              message: contract.message,
            }
          }

          if (remote.bodyHash !== input.baseBodyPointer.bodyHash) {
            return {
              _tag: 'BodyConflict' as const,
              pageId: input.pageId,
              baseBodyPointer: input.baseBodyPointer,
              localBodyHash: input.localBodyHash,
              remoteBodyHash: remote.bodyHash,
              reason: 'StaleSurfaceBase' as const,
              message: 'Local body base does not match the current NotionMD body hash',
            }
          }

          return {
            _tag: 'BodyIntent' as const,
            pageId: input.pageId,
            baseBodyPointer: input.baseBodyPointer,
            nextBodyHash: input.localBodyHash,
            ...(input.localBodyPath === undefined ? {} : { localBodyPath: input.localBodyPath }),
            ...(input.localBodyContent === undefined
              ? {}
              : { localBodyContent: input.localBodyContent }),
          }
        }),
        Effect.mapError(
          (cause) =>
            new BodySyncError({
              operation: 'planLocalChange',
              pageId: input.pageId,
              message: 'Failed to plan NotionMD body change',
              cause,
            }),
        ),
      ),
    push: (command) =>
      Effect.gen(function* () {
        if (command.localBodyContent === undefined || command.localBodyPath === undefined) {
          return yield* new BodySyncError({
            operation: 'push',
            pageId: command.pageId,
            message:
              'NotionMD body push requires a datasource-sync command with local .nmd path and body content',
          })
        }

        const remoteBefore = yield* gateway.pullPage({ pageId: command.pageId })
        const beforePointer = bodyPointerFromMarkdown({
          pageId: command.pageId,
          markdown: remoteBefore.markdown.markdown,
          truncated: remoteBefore.markdown.truncated,
          unknownBlockIds: remoteBefore.markdown.unknown_block_ids,
        })
        const contract = evaluateBodyAdapterContract(beforePointer.safety ?? bodySafetySnapshot())
        if (contract._tag === 'blocked') {
          return yield* new BodySyncError({
            operation: 'push',
            pageId: command.pageId,
            message: `${contract.guard}: ${contract.message}`,
          })
        }

        if (beforePointer.bodyHash !== command.baseBodyPointer.bodyHash) {
          return yield* new BodySyncError({
            operation: 'push',
            pageId: command.pageId,
            message: 'StaleSurfaceBase: local body base does not match the current NotionMD body',
          })
        }

        const updated = yield* gateway.updateMarkdown({
          pageId: command.pageId,
          command: {
            _tag: 'replace_content',
            markdown: command.localBodyContent,
          },
          allowDeletingContent: false,
        })
        const bodyPointer = bodyPointerFromMarkdown({
          pageId: command.pageId,
          markdown: updated.markdown.markdown,
          truncated: updated.markdown.truncated,
          unknownBlockIds: updated.markdown.unknown_block_ids,
        })

        return {
          _tag: 'BodyPushResult' as const,
          pageId: command.pageId,
          requestId: decode({ schema: NotionRequestId, value: `body-push:${command.commandId}` }),
          bodyPointer,
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            cause instanceof BodySyncError
              ? cause
              : new BodySyncError({
                  operation: 'push',
                  pageId: command.pageId,
                  message: 'Failed to push NotionMD page body',
                  cause,
                }),
        ),
      ),
    repair: (input: BodyRepairInput) =>
      gateway.pullPage({ pageId: input.pageId }).pipe(
        Effect.map((page) =>
          bodyPointerFromMarkdown({
            pageId: input.pageId,
            markdown: page.markdown.markdown,
            truncated: page.markdown.truncated,
            unknownBlockIds: page.markdown.unknown_block_ids,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new BodySyncError({
              operation: 'repair',
              pageId: input.pageId,
              message: 'Failed to repair NotionMD page body',
              cause,
            }),
        ),
      ),
  })

export type NotionMdMaterializingLocalWorkspacePortInput = {
  readonly root: AbsolutePath
  readonly gateway: NotionMdGatewayShape
  readonly stateStore: NmdStateStoreShape
}

export const makeNotionMdMaterializingLocalWorkspacePort = ({
  root,
  gateway,
  stateStore,
}: NotionMdMaterializingLocalWorkspacePortInput): LocalWorkspacePortShape => {
  const filesystem = makeFilesystemLocalWorkspacePort({ root })

  return {
    scan: (scanRoot) =>
      filesystem.scan(scanRoot).pipe(
        Stream.mapEffect((observation) => {
          if (
            observation.state !== 'present' ||
            observation.ownWriteSuppressionToken !== undefined
          ) {
            return Effect.succeed(observation)
          }

          const absolutePath = join(root, observation.path)
          return Effect.gen(function* () {
            const content = yield* Effect.tryPromise({
              try: () => readFile(absolutePath, 'utf8'),
              catch: (cause) =>
                new LocalStoreError({
                  operation: 'scan',
                  message: `Failed to read NotionMD body file ${observation.path}`,
                  cause,
                }),
            })
            const parsed = yield* parseNmdFile({ path: observation.path, content }).pipe(
              Effect.mapError(
                (cause) =>
                  new LocalStoreError({
                    operation: 'scan',
                    message: `Failed to parse NotionMD body file ${observation.path}`,
                    cause,
                  }),
              ),
            )

            return {
              ...observation,
              contentHash: sha256Hash(parsed.body),
              bodyContent: parsed.body,
            }
          })
        }),
      ),
    claimPath: filesystem.claimPath,
    materialize: (plan) =>
      Effect.gen(function* () {
        const absolutePath = join(root, plan.path)

        yield* pullPage({ pageId: plan.pageId, outPath: absolutePath }).pipe(
          Effect.provideService(NotionMdGateway, gateway),
          Effect.provideService(NmdStateStore, stateStore),
          Effect.mapError(
            (cause) =>
              new LocalStoreError({
                operation: 'materialize',
                message: 'Failed to materialize NotionMD .nmd body',
                cause,
              }),
          ),
        )

        const content = yield* Effect.promise(() => readFile(absolutePath, 'utf8'))
        const materializedContentHash = sha256Hash(content)
        const token = ownWriteSuppressionToken({
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
        })
        const sidecar: FilesystemWorkspaceSidecar = {
          version: 1,
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
          materializedContentHash,
          ownWriteSuppressionToken: token,
          observedAt: new Date().toISOString(),
        }
        const sidecarPath = filesystemWorkspacePageSidecarPath({ root, pageId: plan.pageId })

        yield* Effect.promise(() => mkdir(dirname(sidecarPath), { recursive: true }))
        yield* Effect.promise(() =>
          writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8'),
        )

        return {
          _tag: 'MaterializeResult' as const,
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
          ownWriteSuppressionToken: token,
        }
      }),
  }
}

export const notionMdPageBodySyncPortLayer = (input: NotionMdPageBodySyncPortInput) =>
  Layer.succeed(PageBodySyncPort, makeNotionMdPageBodySyncPort(input))

export const notionMdMaterializingLocalWorkspacePortLayer = (
  input: NotionMdMaterializingLocalWorkspacePortInput,
) => Layer.succeed(LocalWorkspacePort, makeNotionMdMaterializingLocalWorkspacePort(input))
