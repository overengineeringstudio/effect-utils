import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { resolveCliBuildIdentity } from './cli-build-identity.js'

const GoldenCases = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      baseVersion: Schema.String,
      buildStamp: Schema.String,
      runtimeStamp: Schema.optional(Schema.String),
      now: Schema.Number,
      expected: Schema.Unknown,
    }),
  ),
)

Vitest.describe('Rust / TypeScript CLI build identity parity', () => {
  Vitest.scopedLive('matches every shared golden case byte-for-byte', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture =
        process.env.CLI_BUILD_IDENTITY_GOLDEN ??
        fileURLToPath(
          new URL('../../../../../rust/cli-build-identity/resources/golden.json', import.meta.url),
        )
      const cases = yield* Schema.decodeEffect(GoldenCases)(yield* fs.readFileString(fixture))
      for (const testCase of cases) {
        expect(
          resolveCliBuildIdentity({
            baseVersion: testCase.baseVersion,
            buildStamp: testCase.buildStamp,
            env: { CLI_BUILD_STAMP: testCase.runtimeStamp },
            now: testCase.now,
          }),
          testCase.name,
        ).toEqual(testCase.expected)
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
