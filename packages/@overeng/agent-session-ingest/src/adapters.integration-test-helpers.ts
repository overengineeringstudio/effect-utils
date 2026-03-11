import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { expect } from 'vitest'

import type { SessionSourceAdapter } from './schema/core.ts'

/** Shared Node runtime layer for adapter integration tests. */
export const TestLayer = NodeContext.layer

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
