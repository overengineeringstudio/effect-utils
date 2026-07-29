import { appendFile } from 'node:fs/promises'
import * as nodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { FileSystem } from 'effect/FileSystem'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import type { SessionSourceAdapter } from './schema/core.ts'

/** Raised when a test helper fails to append records to a JSONL artifact. */
export class JsonlArtifactAppendError extends Schema.TaggedErrorClass<JsonlArtifactAppendError>()(
  'JsonlArtifactAppendError',
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Schema-based JSON encoder for test fixtures (mirrors `JSON.stringify`). */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Encodes a value to its JSON string for test fixtures via Effect Schema. */
export const stringifyJson = (value: unknown): string => encodeJson(value)

/** Shared Node runtime layer for adapter integration tests. */
export const TestLayer = NodeServices.layer

/** Ensures the adapter discovers exactly one artifact and returns it. */
export const expectSingleArtifact = <TRecord>(adapter: SessionSourceAdapter<TRecord>) =>
  Effect.gen(function* () {
    const artifacts = yield* adapter.discoverArtifacts
    expect(artifacts).toHaveLength(1)
    const artifact = artifacts[0]
    if (artifact === undefined) {
      return yield* Effect.die('Expected adapter to discover exactly one artifact')
    }
    return artifact
  })

/** Creates a temporary JSONL artifact tree for append-only adapter tests. */
export const makeTempJsonlArtifact = Effect.fn('AgentSessionIngest.Tests.makeTempJsonlArtifact')(
  function* (options: {
    readonly rootDirectoryName: string
    readonly relativeDirectory: string
    readonly filename: string
    readonly records: ReadonlyArray<unknown>
  }) {
    const fs = yield* FileSystem.FileSystem
    const tempDir = yield* fs.makeTempDirectoryScoped()
    const root = nodePath.join(tempDir, options.rootDirectoryName)
    const directory = nodePath.join(root, options.relativeDirectory)
    yield* fs.makeDirectory(directory, { recursive: true })
    const artifactPath = nodePath.join(directory, options.filename)
    yield* fs.writeFileString(
      artifactPath,
      [...options.records.map((record) => JSON.stringify(record)), ''].join('\n'),
    )
    return { root, artifactPath }
  },
)

/** Rewrites a JSONL artifact with a full new record set. */
export const rewriteJsonlArtifact = Effect.fn('AgentSessionIngest.Tests.rewriteJsonlArtifact')(
  function* (options: { readonly path: string; readonly records: ReadonlyArray<unknown> }) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(
      options.path,
      [...options.records.map((record) => JSON.stringify(record)), ''].join('\n'),
    )
  },
)

/** Appends one or more JSONL records without rewriting the existing artifact. */
export const appendJsonlArtifact = Effect.fn('AgentSessionIngest.Tests.appendJsonlArtifact')(
  (options: { readonly path: string; readonly records: ReadonlyArray<unknown> }) =>
    Effect.tryPromise({
      try: () =>
        appendFile(
          options.path,
          [...options.records.map((record) => JSON.stringify(record)), ''].join('\n'),
        ),
      catch: (cause) =>
        new JsonlArtifactAppendError({
          message: `Failed to append JSONL records to ${options.path}`,
          path: options.path,
          cause,
        }),
    }),
)
