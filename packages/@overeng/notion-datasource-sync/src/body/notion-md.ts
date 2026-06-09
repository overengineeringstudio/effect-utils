import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, Layer, Schema, Stream } from 'effect'

import type { BodyCompleteness, BodyLossyReason } from '@overeng/notion-core'
import {
  materializeBody,
  NotionMdGateway,
  NotionMdBodyConflictError,
  NmdStateStore,
  observeRemoteBody,
  readLocalBody,
  replaceRemoteBodyVerified,
  settleVerifiedBodyPush,
  type NotionMdGatewayShape,
  type NmdStateStoreShape,
} from '@overeng/notion-md'

import type { BodyLocalChangeInput, BodyRepairInput, ObserveBodyInput } from '../core/commands.ts'
import {
  BodyPointer,
  type BodySafetySnapshot,
  Hash,
  NotionRequestId,
  type AbsolutePath,
  type PageId,
  type WorkspaceRelativePath,
} from '../core/domain.ts'
import { BodySyncError, LocalStoreError } from '../core/errors.ts'
import {
  LocalWorkspacePort,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { makeFilesystemWorkspaceSidecar } from '../local/sidecar.ts'
import {
  filesystemWorkspacePageSidecarPath,
  makeFilesystemLocalWorkspacePort,
} from '../local/workspace.ts'
import {
  bodySafetySnapshot,
  evaluateBodyAdapterContract,
  withBodyAdapterContract,
} from './adapter.ts'

/** Configuration for the NotionMD-backed `PageBodySyncPort`. */
export type NotionMdPageBodySyncPortInput = {
  readonly gateway: NotionMdGatewayShape
  readonly root?: AbsolutePath
  readonly stateStore?: NmdStateStoreShape
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const hashFromNotionMdDigest = (value: string): Hash => decode({ schema: Hash, value })

const observedAtNow = () => decode({ schema: Schema.DateTimeUtc, value: new Date().toISOString() })

export type NotionBodyFidelityLike = {
  readonly markdown?: {
    readonly truncated?: boolean
    readonly unknownBlockIds?: readonly string[]
  }
  readonly completeness?: BodyCompleteness
}

export type NotionMdRemoteBodyLike = {
  readonly pageId: string
  readonly bodyHash: string
  readonly safety?: BodySafetySnapshot
  readonly fidelity?: NotionBodyFidelityLike
  readonly bodyFidelity?: NotionBodyFidelityLike
  readonly completeness?: BodyCompleteness
}

const unknownBlockCauseFromLossyReasons = (
  reasons: readonly BodyLossyReason[],
): BodySafetySnapshot['unknownBlockCause'] => {
  if (reasons.includes('rendered_markdown_has_unobserved_suffix') === true) return 'truncation'
  if (reasons.includes('unknown_blocks') === true) return 'unknown'
  if (reasons.includes('unsupported_blocks') === true) return 'unsupported'
  if (reasons.includes('rendered_markdown_unavailable') === true) return 'unsupported'
  return undefined
}

const safetyFromNotionMdFidelity = (body: NotionMdRemoteBodyLike): Partial<BodySafetySnapshot> => {
  const fidelity = body.fidelity ?? body.bodyFidelity
  const completeness = body.completeness ?? fidelity?.completeness
  const reasons = completeness?._tag === 'lossy' ? completeness.reasons : []
  const unknownBlockIds = fidelity?.markdown?.unknownBlockIds ?? []
  return {
    truncated:
      fidelity?.markdown?.truncated === true ||
      reasons.includes('endpoint_truncated') ||
      reasons.includes('rendered_markdown_has_unobserved_suffix'),
    unknownBlockCause:
      unknownBlockIds.length > 0 ? 'unknown' : unknownBlockCauseFromLossyReasons(reasons),
  }
}

const mergeNotionMdSafety = (opts: {
  readonly existing: BodySafetySnapshot | undefined
  readonly fidelity: Partial<BodySafetySnapshot>
}): BodySafetySnapshot =>
  bodySafetySnapshot({
    ...opts.existing,
    truncated: opts.existing?.truncated === true || opts.fidelity.truncated === true,
    unknownBlockCause: opts.existing?.unknownBlockCause ?? opts.fidelity.unknownBlockCause,
    adapterMutationSurfaces: ['body'],
    ...(opts.existing === undefined
      ? {}
      : {
          adapterMutationSurfaces:
            opts.existing.adapterMutationSurfaces.includes('body') === true
              ? opts.existing.adapterMutationSurfaces
              : ['body', ...opts.existing.adapterMutationSurfaces],
        }),
  })

/** Convert optional NotionMD/core body-fidelity evidence into datasource-sync's body guard snapshot. */
export const notionMdBodySafetySnapshot = (body: NotionMdRemoteBodyLike): BodySafetySnapshot =>
  mergeNotionMdSafety({
    existing: body.safety,
    fidelity: safetyFromNotionMdFidelity(body),
  })

const bodyPointerFromRemoteBody = (input: {
  readonly pageId: PageId
  readonly bodyHash: string
  readonly safety?: BodySafetySnapshot
}): typeof BodyPointer.Type => {
  return BodyPointer.make({
    _tag: 'BodyPointer',
    pageId: input.pageId,
    bodyHash: hashFromNotionMdDigest(input.bodyHash),
    observedAt: observedAtNow(),
    safety: input.safety ?? bodySafetySnapshot({ adapterMutationSurfaces: ['body'] }),
  })
}

const provideNotionMdGateway =
  (gateway: NotionMdGatewayShape) =>
  <TValue, TError>(effect: Effect.Effect<TValue, TError, NotionMdGateway>) =>
    effect.pipe(Effect.provideService(NotionMdGateway, gateway))

const provideNotionMdStateStore =
  (stateStore: NmdStateStoreShape) =>
  <TValue, TError>(effect: Effect.Effect<TValue, TError, NmdStateStore>) =>
    effect.pipe(Effect.provideService(NmdStateStore, stateStore))

const provideNotionMdGatewayAndStateStore =
  (input: { readonly gateway: NotionMdGatewayShape; readonly stateStore: NmdStateStoreShape }) =>
  <TValue, TError>(effect: Effect.Effect<TValue, TError, NotionMdGateway | NmdStateStore>) =>
    effect.pipe(
      Effect.provideService(NotionMdGateway, input.gateway),
      Effect.provideService(NmdStateStore, input.stateStore),
    )

const writeJsonFile = ({ path, value }: { readonly path: string; readonly value: unknown }) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, path)
    },
    catch: (cause) => cause,
  })

const writeDatasourceSyncBodySidecar = ({
  root,
  pageId,
  path,
  bodyHash,
  materializedContentHash,
}: {
  readonly root: AbsolutePath
  readonly pageId: PageId
  readonly path: WorkspaceRelativePath
  readonly bodyHash: Hash
  readonly materializedContentHash: Hash
}) =>
  writeJsonFile({
    path: filesystemWorkspacePageSidecarPath({ root, pageId }),
    value: makeFilesystemWorkspaceSidecar({
      pageId,
      path,
      bodyHash,
      materializedContentHash,
    }),
  })

/**
 * Build a `PageBodySyncPort` implementation backed by the NotionMD gateway.
 *
 * Wraps the gateway with the body-adapter contract so guards (lossy, unknown blocks,
 * conflict surfaces) fire before any markdown reaches the sync engine.
 */
export const makeNotionMdPageBodySyncPort = ({
  gateway,
  root,
  stateStore,
}: NotionMdPageBodySyncPortInput): PageBodySyncPortShape =>
  withBodyAdapterContract({
    observe: (input: ObserveBodyInput) =>
      observeRemoteBody({ pageId: input.pageId }).pipe(
        provideNotionMdGateway(gateway),
        Effect.map((body) =>
          bodyPointerFromRemoteBody({
            pageId: input.pageId,
            bodyHash: body.bodyHash,
            safety: notionMdBodySafetySnapshot(body),
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
      observeRemoteBody({ pageId: input.pageId }).pipe(
        provideNotionMdGateway(gateway),
        Effect.map((body) => {
          const remote = bodyPointerFromRemoteBody({
            pageId: input.pageId,
            bodyHash: body.bodyHash,
            safety: notionMdBodySafetySnapshot(body),
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

        const replaced = yield* replaceRemoteBodyVerified({
          pageId: command.pageId,
          baseBodyHash: command.baseBodyPointer.bodyHash,
          markdown: command.localBodyContent,
        }).pipe(provideNotionMdGateway(gateway))
        const bodyPointer = bodyPointerFromRemoteBody({
          pageId: command.pageId,
          bodyHash: replaced.bodyHash,
          safety: notionMdBodySafetySnapshot(replaced),
        })

        if (root !== undefined && stateStore !== undefined) {
          const absolutePath = join(root, command.localBodyPath)
          const settled = yield* settleVerifiedBodyPush({
            pageId: command.pageId,
            path: absolutePath,
            expectedLocalBodyHash: command.nextBodyHash,
          }).pipe(provideNotionMdGatewayAndStateStore({ gateway, stateStore }))
          yield* writeDatasourceSyncBodySidecar({
            root,
            pageId: command.pageId,
            path: command.localBodyPath,
            bodyHash: hashFromNotionMdDigest(settled.remoteBodyHash),
            materializedContentHash: hashFromNotionMdDigest(settled.localFileContentHash),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new BodySyncError({
                  operation: 'push',
                  pageId: command.pageId,
                  message: 'Failed to settle local datasource-sync body sidecar after body push',
                  cause,
                }),
            ),
          )
        }

        return {
          _tag: 'BodyPushResult' as const,
          pageId: command.pageId,
          requestId: decode({ schema: NotionRequestId, value: `body-push:${command.commandId}` }),
          bodyPointer,
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof BodySyncError
            ? cause
            : cause instanceof NotionMdBodyConflictError
              ? new BodySyncError({
                  operation: 'push',
                  pageId: command.pageId,
                  message:
                    cause.operation === 'replace_remote_body_verified'
                      ? 'StaleSurfaceBase: local body base does not match the current NotionMD body'
                      : 'Local NotionMD body changed while settling a verified body push; refusing to overwrite the newer local edit',
                  cause,
                })
              : new BodySyncError({
                  operation: 'push',
                  pageId: command.pageId,
                  message: 'Failed to push NotionMD page body',
                  cause,
                }),
        ),
      ),
    repair: (input: BodyRepairInput) =>
      observeRemoteBody({ pageId: input.pageId }).pipe(
        provideNotionMdGateway(gateway),
        Effect.map((body) =>
          bodyPointerFromRemoteBody({
            pageId: input.pageId,
            bodyHash: body.bodyHash,
            safety: notionMdBodySafetySnapshot(body),
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

/** Configuration for `makeNotionMdMaterializingLocalWorkspacePort`: the workspace root, NotionMD gateway, and NMD state store. */
export type NotionMdMaterializingLocalWorkspacePortInput = {
  readonly root: AbsolutePath
  readonly gateway: NotionMdGatewayShape
  readonly stateStore: NmdStateStoreShape
}

/**
 * Build a `LocalWorkspacePort` that, on `materialize`, pulls the page through NotionMD and
 * writes both the `.nmd` body file and a sidecar carrying the own-write suppression token.
 *
 * `scan` augments the filesystem scan with parsed body contents so the sync engine can hash
 * the canonical body, not the on-disk markdown (which may include local edits the engine has
 * not yet observed).
 */
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
            const local = yield* readLocalBody({ path: absolutePath }).pipe(
              provideNotionMdStateStore(stateStore),
              Effect.mapError(
                (cause) =>
                  new LocalStoreError({
                    operation: 'scan',
                    message: `Failed to read NotionMD body file ${observation.path}`,
                    cause,
                  }),
              ),
            )

            return {
              ...observation,
              contentHash: hashFromNotionMdDigest(local.bodyHash),
              bodyContent: local.markdown,
            }
          })
        }),
      ),
    claimPath: filesystem.claimPath,
    materialize: (plan) =>
      Effect.gen(function* () {
        const absolutePath = join(root, plan.path)

        const materialized = yield* materializeBody({
          pageId: plan.pageId,
          outPath: absolutePath,
        }).pipe(
          provideNotionMdGatewayAndStateStore({ gateway, stateStore }),
          Effect.mapError(
            (cause) =>
              new LocalStoreError({
                operation: 'materialize',
                message: 'Failed to materialize NotionMD .nmd body',
                cause,
              }),
          ),
        )

        const sidecar = makeFilesystemWorkspaceSidecar({
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
          materializedContentHash: hashFromNotionMdDigest(materialized.fileContentHash),
        })
        yield* writeJsonFile({
          path: filesystemWorkspacePageSidecarPath({ root, pageId: plan.pageId }),
          value: sidecar,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new LocalStoreError({
                operation: 'materialize',
                message: 'Failed to write datasource-sync body sidecar after NotionMD materialize',
                cause,
              }),
          ),
        )

        return {
          _tag: 'MaterializeResult' as const,
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
          ownWriteSuppressionToken: sidecar.ownWriteSuppressionToken,
        }
      }),
  }
}

/** Effect `Layer` providing the NotionMD-backed `PageBodySyncPort` to consumers (CLI, daemon, tests). */
export const notionMdPageBodySyncPortLayer = (input: NotionMdPageBodySyncPortInput) =>
  Layer.succeed(PageBodySyncPort, makeNotionMdPageBodySyncPort(input))

/** Effect `Layer` providing the NotionMD-materializing `LocalWorkspacePort` to consumers. */
export const notionMdMaterializingLocalWorkspacePortLayer = (
  input: NotionMdMaterializingLocalWorkspacePortInput,
) => Layer.succeed(LocalWorkspacePort, makeNotionMdMaterializingLocalWorkspacePort(input))
