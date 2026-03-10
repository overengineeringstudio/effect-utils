import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { ContentVersionCursor, MutableReadResult } from '../schema/core.ts'
import { ContentVersion } from '../schema/core.ts'

const hashText = (text: string) => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`
}

const buildContentVersion = (options: {
  sizeBytes: number
  modifiedAtEpochMs: number
  tailSample: string
}) =>
  Schema.decodeUnknownSync(ContentVersion)({
    sizeBytes: options.sizeBytes,
    modifiedAtEpochMs: options.modifiedAtEpochMs,
    tailHash: hashText(options.tailSample),
  })

const isSameContentVersion = (options: {
  previous: ContentVersionCursor['contentVersion'] | undefined
  next: typeof ContentVersion.Type
}) =>
  options.previous?.sizeBytes === options.next.sizeBytes &&
  options.previous?.modifiedAtEpochMs === options.next.modifiedAtEpochMs &&
  options.previous?.tailHash === options.next.tailHash

/** Reads a mutable artifact only when its content version changed since the last checkpoint. */
export const readMutableTextFileIfChanged = Effect.fn(
  'AgentSessionIngest.readMutableTextFileIfChanged',
)((options: { path: string; previous: ContentVersionCursor | undefined }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(options.path).pipe(
      Effect.mapError(
        (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to stat mutable artifact',
            path: options.path,
            cause,
          }),
      ),
    )

    const content = yield* fs.readFileString(options.path).pipe(
      Effect.mapError(
        (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to read mutable artifact',
            path: options.path,
            cause,
          }),
      ),
    )

    const contentVersion = buildContentVersion({
      sizeBytes: Number(info.size),
      modifiedAtEpochMs: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
      tailSample: content.slice(Math.max(0, content.length - 512)),
    })

    return {
      content,
      contentVersion,
      changed:
        isSameContentVersion({
          previous: options.previous?.contentVersion,
          next: contentVersion,
        }) !== true,
    } satisfies MutableReadResult
  }),
)
