import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import { SessionArtifactReadError } from '../errors.ts'
import type { ContentVersion, ContentVersionCursor, MutableReadResult } from '../schema/core.ts'
import { readFileContentVersion } from './content-version.ts'

const isSameContentVersion = (options: {
  previous: ContentVersionCursor['contentVersion'] | undefined
  next: ContentVersion
}) =>
  options.previous?.sizeBytes === options.next.sizeBytes &&
  options.previous?.modifiedAtEpochMs === options.next.modifiedAtEpochMs &&
  options.previous?.headHash === options.next.headHash &&
  options.previous?.tailHash === options.next.tailHash

/** Reads a mutable artifact only when its content version changed since the last checkpoint. */
export const readMutableTextFileIfChanged = Effect.fn(
  'AgentSessionIngest.readMutableTextFileIfChanged',
)((options: { path: string; previous: ContentVersionCursor | undefined }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
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

    const contentVersion = yield* readFileContentVersion(options.path)

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
