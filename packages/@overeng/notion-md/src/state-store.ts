import { randomUUID } from 'node:crypto'

import { FileSystem, Path } from '@effect/platform'
import { Context, Effect, Layer, Schema } from 'effect'

import {
  NmdObjectRefSchema,
  NmdStorageSchema,
  NmdSyncStateV1Schema,
  Sha256DigestSchema,
  type NmdObjectRef,
  type NmdObjectRole,
  type NmdStorage,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

import { NmdFileSystemError, NmdObjectStoreError } from './errors.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'

const compareStrings = new Intl.Collator().compare

/** Strict schema for overflow `.nmd` storage payloads in the object store. */
export const NmdStorageObjectV2 = Schema.Struct({
  version: Schema.Literal(2),
  page_id: Schema.String,
  reason: Schema.Literal('too_large', 'volatile_url'),
  storage: NmdStorageSchema,
}).annotations({ identifier: 'NotionMd.StorageObjectV2' })

export type NmdStorageObjectV2 = typeof NmdStorageObjectV2.Type

/** Strict schema for the last clean body snapshot used by guarded merges. */
export const NmdBaseSnapshotV2 = Schema.Struct({
  version: Schema.Literal(2),
  page_id: Schema.String,
  body_hash: Sha256DigestSchema,
  body: Schema.String,
}).annotations({ identifier: 'NotionMd.BaseSnapshotV2' })

export type NmdBaseSnapshotV2 = typeof NmdBaseSnapshotV2.Type

const strictOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

const encodeStorageObjectJson = Schema.encodeSync(
  Schema.parseJson(NmdStorageObjectV2, { space: 2 }),
)
const encodeBaseSnapshotJson = Schema.encodeSync(Schema.parseJson(NmdBaseSnapshotV2, { space: 2 }))
const encodeSyncStateJson = Schema.encodeSync(Schema.parseJson(NmdSyncStateV1Schema, { space: 2 }))
const decodeStorageObjectJson = Schema.decodeUnknown(
  Schema.parseJson(NmdStorageObjectV2),
  strictOptions,
)
const decodeBaseSnapshotJson = Schema.decodeUnknown(
  Schema.parseJson(NmdBaseSnapshotV2),
  strictOptions,
)
const decodeSyncStateJson = Schema.decodeUnknown(
  Schema.parseJson(NmdSyncStateV1Schema),
  strictOptions,
)
const decodeObjectRef = Schema.decodeUnknownSync(NmdObjectRefSchema, strictOptions)

/** Local metadata root next to a synced `.nmd` file. */
export const stateRootPath = (path: string): string => {
  const baseName = path.split(/[\\/]/u).at(-1) ?? path
  return `${path.slice(0, Math.max(0, path.length - baseName.length))}.notion-md`
}

/** Relative path for a content-addressed object inside the local metadata root. */
export const objectRelativePath = (hash: string): string => {
  const hex = hash.slice('sha256:'.length)
  return `.notion-md/objects/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.json`
}

/** Absolute object path for a content-addressed hash next to a synced `.nmd` file. */
export const objectPath = (opts: { readonly path: string; readonly hash: string }): string => {
  const baseName = opts.path.split(/[\\/]/u).at(-1) ?? opts.path
  const root = opts.path.slice(0, Math.max(0, opts.path.length - baseName.length))
  return `${root}${objectRelativePath(opts.hash)}`
}

/** Absolute sidecar sync-state path for a `.nmd` file, keyed by immutable page id. */
export const syncStatePath = (opts: { readonly path: string; readonly pageId: string }): string => {
  const baseName = opts.path.split(/[\\/]/u).at(-1) ?? opts.path
  const root = opts.path.slice(0, Math.max(0, opts.path.length - baseName.length))
  return `${root}.notion-md/sync/${opts.pageId}.json`
}

const byteLength = (content: string): number => new TextEncoder().encode(content).byteLength

const makeObjectRef = (opts: {
  readonly role: NmdObjectRole
  readonly hash: string
  readonly content: string
}): NmdObjectRef =>
  decodeObjectRef({
    _tag: 'object_ref',
    role: opts.role,
    hash: opts.hash,
    path: objectRelativePath(opts.hash),
    media_type: 'application/json',
    byte_length: byteLength(opts.content),
  })

/** Returns whether an object-store path is relative and cannot traverse above the `.nmd` directory. */
export const isSafeRelativePath = (opts: {
  readonly path: Path.Path
  readonly relativePath: string
}): boolean => {
  if (opts.path.isAbsolute(opts.relativePath) === true) return false
  const normalized = opts.path.normalize(opts.relativePath)
  return normalized !== '..' && normalized.startsWith(`..${opts.path.sep}`) === false
}

const parseObjectJson = <A>(opts: {
  readonly parse: (content: string) => Effect.Effect<A, unknown>
  readonly path: string
  readonly objectPath: string
  readonly content: string
  readonly label: string
}): Effect.Effect<A, NmdObjectStoreError> =>
  opts.parse(opts.content).pipe(
    Effect.mapError(
      (cause) =>
        new NmdObjectStoreError({
          path: opts.path,
          object_path: opts.objectPath,
          cause,
          message: `Failed to parse ${opts.label} ${opts.objectPath}`,
        }),
    ),
  )

const inventory = (
  storage: NmdStorage,
): {
  readonly unsupportedBlockIds: readonly string[]
  readonly fileIds: readonly string[]
  readonly commentIds: readonly string[]
} => {
  switch (storage._tag) {
    case 'self_contained':
      return {
        unsupportedBlockIds: storage.unsupported_blocks
          .map((block) => block.block_id)
          .toSorted(compareStrings),
        fileIds: storage.files.map((file) => file.id).toSorted(compareStrings),
        commentIds: storage.comments.map((comment) => comment.id).toSorted(compareStrings),
      }
    case 'object_store':
      return {
        unsupportedBlockIds: [...storage.unsupported_block_ids].toSorted(compareStrings),
        fileIds: [...storage.file_ids].toSorted(compareStrings),
        commentIds: [...storage.comment_ids].toSorted(compareStrings),
      }
  }
}

const sameStrings = (opts: {
  readonly left: readonly string[]
  readonly right: readonly string[]
}): boolean =>
  opts.left.length === opts.right.length &&
  opts.left.every((value, index) => value === opts.right[index])

const sameInventory = (opts: {
  readonly left: NmdStorage
  readonly right: NmdStorage
}): boolean => {
  const leftInventory = inventory(opts.left)
  const rightInventory = inventory(opts.right)
  return (
    sameStrings({
      left: leftInventory.unsupportedBlockIds,
      right: rightInventory.unsupportedBlockIds,
    }) &&
    sameStrings({ left: leftInventory.fileIds, right: rightInventory.fileIds }) &&
    sameStrings({ left: leftInventory.commentIds, right: rightInventory.commentIds })
  )
}

/** Effect service contract for all local `.nmd` and `.notion-md` filesystem state. */
export interface NmdStateStoreShape {
  readonly readNmdFile: (opts: {
    readonly path: string
  }) => Effect.Effect<string, NmdFileSystemError>
  readonly writeNmdFile: (opts: {
    readonly path: string
    readonly content: string
  }) => Effect.Effect<void, NmdFileSystemError>
  readonly writeConflictFile: (opts: {
    readonly path: string
    readonly content: string
  }) => Effect.Effect<void, NmdFileSystemError>
  readonly writeBaseSnapshot: (opts: {
    readonly path: string
    readonly pageId: string
    readonly body: string
  }) => Effect.Effect<NmdObjectRef, NmdFileSystemError>
  readonly readBaseSnapshot: (opts: {
    readonly path: string
    readonly syncState: NmdSyncStateV1
  }) => Effect.Effect<NmdBaseSnapshotV2, NmdObjectStoreError>
  readonly writeStorageObject: (opts: {
    readonly path: string
    readonly pageId: string
    readonly reason: 'too_large' | 'volatile_url'
    readonly storage: NmdStorage
  }) => Effect.Effect<NmdObjectRef, NmdFileSystemError>
  readonly validateReferencedObjects: (opts: {
    readonly path: string
    readonly syncState: NmdSyncStateV1
  }) => Effect.Effect<NmdStorageObjectV2 | undefined, NmdObjectStoreError>
  /*
   * Sidecar sync state at `.notion-md/sync/{page_id}.json`. Holds the
   * derived bookkeeping (body hash, base ref, last-pulled timestamps,
   * read-only property echoes, data-source binding) that used to live
   * inside the `.nmd` frontmatter. Keyed by immutable `page_id`, so the
   * file survives a `git mv` of the `.nmd` companion.
   */
  readonly writeSyncState: (opts: {
    readonly path: string
    readonly syncState: NmdSyncStateV1
  }) => Effect.Effect<void, NmdFileSystemError>
  readonly readSyncState: (opts: {
    readonly path: string
    readonly pageId: string
  }) => Effect.Effect<NmdSyncStateV1, NmdObjectStoreError>
  /** Returns `undefined` when the sidecar has not been materialized yet (pre-first-sync). */
  readonly readSyncStateOptional: (opts: {
    readonly path: string
    readonly pageId: string
  }) => Effect.Effect<NmdSyncStateV1 | undefined, NmdObjectStoreError>
}

/** Service tag for the local notion-md state store. */
export class NmdStateStore extends Context.Tag('NmdStateStore')<
  NmdStateStore,
  NmdStateStoreShape
>() {}

/** Live state-store implementation backed by `@effect/platform` filesystem services. */
export const NmdStateStoreLive = Layer.effect(
  NmdStateStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const makeFileSystemError = (opts: {
      readonly operation: string
      readonly path: string
      readonly cause: unknown
      readonly message: string
    }): NmdFileSystemError =>
      new NmdFileSystemError({
        operation: opts.operation,
        path: opts.path,
        cause: opts.cause,
        message: opts.message,
      })

    const fullObjectPath = (opts: { readonly nmdPath: string; readonly object: NmdObjectRef }) =>
      Effect.try({
        try: () => {
          if (isSafeRelativePath({ path, relativePath: opts.object.path }) === false) {
            throw new Error('Object path must be relative and must not traverse')
          }
          if (
            path.normalize(opts.object.path) !==
            path.normalize(objectRelativePath(opts.object.hash))
          ) {
            throw new Error('Object path must match its content hash')
          }
          return path.join(path.dirname(opts.nmdPath), path.normalize(opts.object.path))
        },
        catch: (cause) =>
          new NmdObjectStoreError({
            path: opts.nmdPath,
            object_path: opts.object.path,
            cause,
            message: `Invalid .nmd object reference ${opts.object.path}`,
          }),
      })

    const writeTextFile = (opts: {
      readonly operation: string
      readonly path: string
      readonly content: string
      readonly label: string
    }): Effect.Effect<void, NmdFileSystemError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryPath = `${opts.path}.tmp-${process.pid}-${randomUUID()}`
          yield* Effect.addFinalizer(() => fs.remove(temporaryPath).pipe(Effect.ignore))
          yield* fs.makeDirectory(path.dirname(opts.path), { recursive: true })
          yield* fs.writeFileString(temporaryPath, opts.content)
          yield* fs.rename(temporaryPath, opts.path)
        }),
      ).pipe(
        Effect.mapError((cause) =>
          makeFileSystemError({
            operation: opts.operation,
            path: opts.path,
            cause,
            message: `Failed to write ${opts.label} ${opts.path}`,
          }),
        ),
        Effect.withSpan(`notion-md.state.${opts.operation}`, {
          attributes: {
            'span.label': path.basename(opts.path),
            'notion_md.state.operation': opts.operation,
            'notion_md.path.basename': path.basename(opts.path),
          },
        }),
      )

    const readNmdFile: NmdStateStoreShape['readNmdFile'] = (opts) =>
      fs.readFileString(opts.path).pipe(
        Effect.mapError((cause) =>
          makeFileSystemError({
            operation: 'read_nmd',
            path: opts.path,
            cause,
            message: `Failed to read .nmd file ${opts.path}`,
          }),
        ),
        Effect.withSpan('notion-md.state.read-nmd', {
          attributes: {
            'span.label': path.basename(opts.path),
            'notion_md.state.operation': 'read_nmd',
            'notion_md.path.basename': path.basename(opts.path),
          },
        }),
      )

    const writeObjectContent = (opts: {
      readonly path: string
      readonly role: NmdObjectRole
      readonly content: string
    }): Effect.Effect<NmdObjectRef, NmdFileSystemError> =>
      Effect.gen(function* () {
        const content = `${opts.content.trimEnd()}\n`
        const hash = sha256Digest(content)
        const destination = objectPath({ path: opts.path, hash })
        yield* writeTextFile({
          operation: 'write_object',
          path: destination,
          content,
          label: '.notion-md object',
        })
        yield* Effect.annotateCurrentSpan('notion_md.object.hash_prefix', hash.slice(0, 18))
        return makeObjectRef({ role: opts.role, hash, content })
      }).pipe(
        Effect.withSpan('notion-md.state.write-object', {
          attributes: {
            'span.label': opts.role,
            'notion_md.object.role': opts.role,
            'notion_md.path.basename': path.basename(opts.path),
          },
        }),
      )

    const readObjectContent = (opts: {
      readonly path: string
      readonly object: NmdObjectRef
    }): Effect.Effect<string, NmdObjectStoreError> =>
      Effect.gen(function* () {
        const objectFullPath = yield* fullObjectPath({ nmdPath: opts.path, object: opts.object })
        const content = yield* fs.readFileString(objectFullPath).pipe(
          Effect.mapError(
            (cause) =>
              new NmdObjectStoreError({
                path: opts.path,
                object_path: objectFullPath,
                cause,
                message: `Failed to read .nmd object ${objectFullPath}`,
              }),
          ),
        )
        const hash = sha256Digest(content)
        if (hash !== opts.object.hash) {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: objectFullPath,
            message: `Invalid .nmd object hash for ${objectFullPath}`,
          })
        }
        return content
      }).pipe(
        Effect.withSpan('notion-md.state.read-object', {
          attributes: {
            'span.label': opts.object.role,
            'notion_md.object.role': opts.object.role,
            'notion_md.object.hash_prefix': opts.object.hash.slice(0, 18),
          },
        }),
      )

    const writeBaseSnapshot: NmdStateStoreShape['writeBaseSnapshot'] = (opts) => {
      const body = normalizeMarkdownLineEndings(opts.body)
      return writeObjectContent({
        path: opts.path,
        role: 'base_snapshot',
        content: encodeBaseSnapshotJson({
          version: 2,
          page_id: opts.pageId,
          body_hash: sha256Digest(body),
          body,
        }),
      })
    }

    const readBaseSnapshot: NmdStateStoreShape['readBaseSnapshot'] = (opts) =>
      Effect.gen(function* () {
        const ref = opts.syncState.body.base
        if (ref.role !== 'base_snapshot') {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: ref.path,
            message: `Expected base_snapshot object but found ${ref.role}`,
          })
        }
        const snapshot = yield* readObjectContent({ path: opts.path, object: ref }).pipe(
          Effect.flatMap((content) =>
            parseObjectJson({
              parse: decodeBaseSnapshotJson,
              path: opts.path,
              objectPath: ref.path,
              content,
              label: '.nmd base snapshot',
            }),
          ),
        )

        if (
          snapshot.page_id !== opts.syncState.page_id ||
          snapshot.body_hash !== opts.syncState.body.hash ||
          sha256Digest(snapshot.body) !== snapshot.body_hash
        ) {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: ref.path,
            message: `Invalid .nmd base snapshot ${ref.path}`,
          })
        }

        return snapshot
      })

    const writeStorageObject: NmdStateStoreShape['writeStorageObject'] = (opts) =>
      writeObjectContent({
        path: opts.path,
        role: 'storage_payload',
        content: encodeStorageObjectJson({
          version: 2,
          page_id: opts.pageId,
          reason: opts.reason,
          storage: opts.storage,
        }),
      })

    const validateReferencedObjects: NmdStateStoreShape['validateReferencedObjects'] = (opts) =>
      Effect.gen(function* () {
        yield* readBaseSnapshot(opts)
        const storage = opts.syncState.storage
        if (storage._tag !== 'object_store') return undefined
        const ref = storage.object
        if (ref.role !== 'storage_payload') {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: ref.path,
            message: `Expected storage_payload object but found ${ref.role}`,
          })
        }
        const storageObject = yield* readObjectContent({ path: opts.path, object: ref }).pipe(
          Effect.flatMap((content) =>
            parseObjectJson({
              parse: decodeStorageObjectJson,
              path: opts.path,
              objectPath: ref.path,
              content,
              label: '.nmd storage object',
            }),
          ),
        )
        if (storageObject.page_id !== opts.syncState.page_id) {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: ref.path,
            message: `Storage object page id ${storageObject.page_id} does not match ${opts.syncState.page_id}`,
          })
        }
        if (sameInventory({ left: storage, right: storageObject.storage }) === false) {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: ref.path,
            message: `Storage object inventory does not match frontmatter inventory for ${ref.path}`,
          })
        }
        return storageObject
      })

    const writeSyncState: NmdStateStoreShape['writeSyncState'] = (opts) =>
      writeTextFile({
        operation: 'write_sync_state',
        path: syncStatePath({ path: opts.path, pageId: opts.syncState.page_id }),
        content: encodeSyncStateJson(opts.syncState),
        label: '.nmd sync state',
      })

    const readSyncState: NmdStateStoreShape['readSyncState'] = (opts) =>
      Effect.gen(function* () {
        const sidecarPath = syncStatePath({ path: opts.path, pageId: opts.pageId })
        const content = yield* fs.readFileString(sidecarPath).pipe(
          Effect.mapError(
            (cause) =>
              new NmdObjectStoreError({
                path: opts.path,
                object_path: sidecarPath,
                cause,
                message: `Failed to read .nmd sync state ${sidecarPath}`,
              }),
          ),
        )
        const decoded = yield* parseObjectJson({
          parse: decodeSyncStateJson,
          path: opts.path,
          objectPath: sidecarPath,
          content,
          label: '.nmd sync state',
        })
        if (decoded.page_id !== opts.pageId) {
          return yield* new NmdObjectStoreError({
            path: opts.path,
            object_path: sidecarPath,
            message: `Sync state page id ${decoded.page_id} does not match expected ${opts.pageId}`,
          })
        }
        return decoded
      })

    const readSyncStateOptional: NmdStateStoreShape['readSyncStateOptional'] = (opts) =>
      Effect.gen(function* () {
        const sidecarPath = syncStatePath({ path: opts.path, pageId: opts.pageId })
        const exists = yield* fs.exists(sidecarPath).pipe(
          Effect.mapError(
            (cause) =>
              new NmdObjectStoreError({
                path: opts.path,
                object_path: sidecarPath,
                cause,
                message: `Failed to probe .nmd sync state ${sidecarPath}`,
              }),
          ),
        )
        if (exists === false) return undefined
        return yield* readSyncState(opts)
      })

    return {
      readNmdFile,
      writeNmdFile: (opts) =>
        writeTextFile({
          operation: 'write_nmd',
          path: opts.path,
          content: opts.content,
          label: '.nmd file',
        }),
      writeConflictFile: (opts) =>
        writeTextFile({
          operation: 'write_conflict',
          path: opts.path,
          content: opts.content,
          label: 'Roughdraft conflict file',
        }),
      writeBaseSnapshot,
      readBaseSnapshot,
      writeStorageObject,
      validateReferencedObjects,
      writeSyncState,
      readSyncState,
      readSyncStateOptional,
    }
  }),
)

/** Write the last clean body snapshot and return the strict frontmatter reference. */
export const writeBaseSnapshot = (opts: {
  readonly path: string
  readonly pageId: string
  readonly body: string
}): Effect.Effect<NmdObjectRef, NmdFileSystemError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.writeBaseSnapshot(opts)))

/** Load and validate the last clean body snapshot for conflict handling. */
export const readBaseSnapshot = (opts: {
  readonly path: string
  readonly syncState: NmdSyncStateV1
}): Effect.Effect<NmdBaseSnapshotV2, NmdObjectStoreError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.readBaseSnapshot(opts)))

/** Write a storage overflow payload and return the strict frontmatter reference. */
export const writeStorageObject = (opts: {
  readonly path: string
  readonly pageId: string
  readonly reason: 'too_large' | 'volatile_url'
  readonly storage: NmdStorage
}): Effect.Effect<NmdObjectRef, NmdFileSystemError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.writeStorageObject(opts)))

/** Load and validate object-store storage referenced by the sync state, if present. */
export const validateReferencedObjects = (opts: {
  readonly path: string
  readonly syncState: NmdSyncStateV1
}): Effect.Effect<NmdStorageObjectV2 | undefined, NmdObjectStoreError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.validateReferencedObjects(opts)))

/** Write the sidecar sync state at `.notion-md/sync/{page_id}.json`. */
export const writeSyncState = (opts: {
  readonly path: string
  readonly syncState: NmdSyncStateV1
}): Effect.Effect<void, NmdFileSystemError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.writeSyncState(opts)))

/** Read the sidecar sync state for a known page id; fails if missing. */
export const readSyncState = (opts: {
  readonly path: string
  readonly pageId: string
}): Effect.Effect<NmdSyncStateV1, NmdObjectStoreError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.readSyncState(opts)))

/** Read the sidecar sync state if it exists, else undefined (pre-first-sync). */
export const readSyncStateOptional = (opts: {
  readonly path: string
  readonly pageId: string
}): Effect.Effect<NmdSyncStateV1 | undefined, NmdObjectStoreError, NmdStateStore> =>
  NmdStateStore.pipe(Effect.flatMap((store) => store.readSyncStateOptional(opts)))
