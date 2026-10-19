import { NodeFileSystem } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { Effect, FileSystem, Schema } from 'effect'
import { expect } from 'vitest'

import {
  ErrorCode, Manifest, WorkStorage, decodeManifest, readManifest, resolveRequest,
} from './mod.ts'

const Fixture = Schema.Struct({
  name: Schema.String,
  request: Schema.Unknown,
  expected: Schema.Union([Schema.Struct({ ok: Schema.String }), Schema.Struct({ error: ErrorCode })]),
})
// Collection reads the exact same normative files as the Rust conformance target.
const { fixtures, neutral } = await Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return {
    fixtures: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Fixture)))(
      yield* fs.readFileString(new URL('../fixtures/conformance.json', import.meta.url).pathname),
    ),
    neutral: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
      yield* fs.readFileString(new URL('../protocol.schema.json', import.meta.url).pathname),
    ),
  }
}).pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise)
const validateManifest = new Ajv2020({ strict: false }).compile(neutral)
const manifestFrom = Schema.Struct({ manifest: Schema.Unknown })

 describe('work-storage v1 normative fixtures', () => {
  for (const fixture of fixtures) {
    it.effect(fixture.name, () => Effect.gen(function* () {
      const result = yield* resolveRequest(fixture.request).pipe(
        Effect.map((ok) => ({ ok })),
        Effect.catch((error) => Effect.succeed({ error: error.code })),
      )
      expect(result).toEqual(fixture.expected)
      if (Schema.is(manifestFrom)(fixture.request) === true) {
        const manifest = fixture.request.manifest
        expect(Schema.is(Manifest)(manifest)).toBe(validateManifest(manifest))
        if (validateManifest(manifest) === false) expect(fixture.expected).toEqual({ error: 'InvalidManifest' })
      }
    }))
  }
})

const example = {
  version: 1,
  app: 'demo',
  provider: { kind: 'fixture', root: '/factory', identity: 'fixture-volume' },
  paths: { state: '/factory/state/demo' },
  environment: { XDG_STATE_HOME: '/factory/state/demo' },
}
const observed = { present: true, identity: 'fixture-volume' }
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

describe('WorkStorage service and file boundary', () => {
  it.effect('provides declared roles and environment without process mutation', () => Effect.gen(function* () {
    const prior = process.env.XDG_STATE_HOME
    const result = yield* Effect.gen(function* () {
      const storage = yield* WorkStorage
      return { path: yield* storage.role('state'), environment: storage.environment }
    }).pipe(Effect.provide(WorkStorage.layer(example, observed)))
    expect(result).toEqual({ path: '/factory/state/demo', environment: example.environment })
    expect(process.env.XDG_STATE_HOME).toBe(prior)
  }))

  it.scoped('reads a manifest through the platform filesystem and builds a Layer', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'work-storage-' })
    const path = `${directory}/manifest.json`
    yield* fs.writeFileString(path, encodeJson(example))
    const result = yield* Effect.gen(function* () {
      const storage = yield* WorkStorage
      return yield* storage.role('state')
    }).pipe(Effect.provide(WorkStorage.layerFile(path, observed)))
    expect(result).toBe('/factory/state/demo')
    expect(yield* fs.readFileString(path)).toBe(encodeJson(example))
    const missing = yield* readManifest(`${directory}/absent.json`).pipe(
      Effect.map(() => 'unexpected-success'),
      Effect.catch((error) => Effect.succeed(error._tag)),
    )
    expect(missing).toBe('ManifestReadError')
  }).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect('rejects malformed JSON rather than choosing a fallback manifest', () => Effect.gen(function* () {
    const result = yield* decodeManifest('{').pipe(
      Effect.map(() => 'unexpected-success'),
      Effect.catch((error) => Effect.succeed(error.code)),
    )
    expect(result).toBe('InvalidManifest')
  }))
})
