import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { AppendOnlyReadResult } from '../schema/core.ts'
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

export const readAppendOnlyTextFileSince = Effect.fn(
  'AgentSessionIngest.readAppendOnlyTextFileSince',
)((options: { path: string; offsetBytes: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(options.path).pipe(
      Effect.mapError(
        (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to stat append-only artifact',
            path: options.path,
            cause,
          }),
      ),
    )

    const sizeBytes = Number(info.size)
    const normalizedOffsetBytes = sizeBytes < options.offsetBytes ? 0 : options.offsetBytes
    const fullText = yield* fs.readFileString(options.path).pipe(
      Effect.mapError(
        (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to read append-only artifact',
            path: options.path,
            cause,
          }),
      ),
    )

    const nextText = fullText.slice(normalizedOffsetBytes)
    const tailSample = fullText.slice(Math.max(0, fullText.length - 512))

    return {
      text: nextText,
      nextOffsetBytes: sizeBytes,
      resetToStart: normalizedOffsetBytes === 0 && options.offsetBytes > 0,
      contentVersion: buildContentVersion({
        sizeBytes,
        modifiedAtEpochMs: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        tailSample,
      }),
    } satisfies AppendOnlyReadResult
  }),
)
