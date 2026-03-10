import { open as openFile } from 'node:fs/promises'

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

const readByteAt = (options: { path: string; offsetBytes: number }) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await openFile(options.path, 'r')
      try {
        const buffer = Buffer.alloc(1)
        const { bytesRead } = await handle.read(buffer, 0, 1, options.offsetBytes)
        return bytesRead === 0 ? undefined : buffer.toString('utf8', 0, 1)
      } finally {
        await handle.close()
      }
    },
    catch: (cause) =>
      new SessionArtifactReadError({
        message: 'Failed to read append-only artifact boundary byte',
        path: options.path,
        cause,
      }),
  })

export const readAppendOnlyTextFileSince = Effect.fn(
  'AgentSessionIngest.readAppendOnlyTextFileSince',
)((options: { path: string; offsetBytes: number; initialReadMaxBytes?: number }) =>
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
    const boundedInitialOffsetBytes =
      normalizedOffsetBytes === 0 &&
      options.offsetBytes === 0 &&
      options.initialReadMaxBytes !== undefined &&
      sizeBytes > options.initialReadMaxBytes
        ? sizeBytes - options.initialReadMaxBytes
        : normalizedOffsetBytes

    const readText = yield* Effect.tryPromise({
      try: async () => {
        const length = Math.max(0, sizeBytes - boundedInitialOffsetBytes)
        if (length === 0) return ''

        const handle = await openFile(options.path, 'r')
        try {
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, boundedInitialOffsetBytes)
          return buffer.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close()
        }
      },
      catch: (cause) =>
        new SessionArtifactReadError({
          message: 'Failed to read append-only artifact',
          path: options.path,
          cause,
        }),
    })

    const tailSample = yield* Effect.tryPromise({
      try: async () => {
        const length = Math.min(512, sizeBytes)
        if (length === 0) return ''

        const handle = await openFile(options.path, 'r')
        try {
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, sizeBytes - length)
          return buffer.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close()
        }
      },
      catch: (cause) =>
        new SessionArtifactReadError({
          message: 'Failed to read append-only artifact tail sample',
          path: options.path,
          cause,
        }),
    })

    const startedFromTail = boundedInitialOffsetBytes > 0 && options.offsetBytes === 0
    const beginsOnLineBoundary =
      startedFromTail !== true
        ? false
        : boundedInitialOffsetBytes === 0
          ? true
          : (yield* readByteAt({
              path: options.path,
              offsetBytes: boundedInitialOffsetBytes - 1,
            })) === '\n'
    const nextText = startedFromTail
      ? beginsOnLineBoundary
        ? readText
        : (() => {
          const firstNewlineIndex = readText.indexOf('\n')
          return firstNewlineIndex === -1 ? '' : readText.slice(firstNewlineIndex + 1)
        })()
      : readText

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
