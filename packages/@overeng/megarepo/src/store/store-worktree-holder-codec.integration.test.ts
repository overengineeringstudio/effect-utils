import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { HolderEvidenceResponse } from './store-worktree-holder-codec.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const fixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(
    new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url).pathname,
  )
  return text.trimEnd().split('\n')
})
const untypedJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))
const decode = Schema.decodeEffect(Schema.fromJsonString(HolderEvidenceResponse), {
  onExcessProperty: 'error',
})

// These are Rust codec emissions, not a live host census or native qualification.
describe('unbound worktree holder wire schema', () => {
  it.effect('preserves every field of all nine canonical Rust fixtures', (test) =>
    Effect.gen(function* () {
      const lines = yield* fixtures
      expect(lines).toHaveLength(9)
      for (const stdout of lines) {
        const actual = yield* decode(stdout)
        expect(actual).toEqual(untypedJson(stdout))
      }
    }).pipe(withTestCtx(test)),
  )

  it.effect('rejects malformed JSON, versions, capture and scope inconsistencies', (test) =>
    Effect.gen(function* () {
      const clear = (yield* fixtures)[0]!
      for (const stdout of [
        '',
        '{secret',
        ' '.repeat(16 * 1024 * 1024 + 1),
        clear + clear,
        clear.replace('"version":1', '"version":2'),
        clear.replace('"kind":"worktree"', '"kind":"store"'),
        clear.replace('"allUids":true', '"allUids":false'),
        clear.replace('"allTasks":true', '"allTasks":false'),
        clear.replace('"processCount":1', '"processCount":3'),
        clear.replace('"startedBootNs":"1000000000"', '"startedBootNs":"3000000000"'),
        clear.replace('"finishedBootNs":"2000000000"', '"finishedBootNs":"27000000000"'),
        clear.replace('"expiresBootNs":"31000000000"', '"expiresBootNs":"32000000000"'),
        clear.replace('"ino":"9"', '"ino":"0"'),
        clear.replace('"complete":true', '"complete":false'),
        clear.replace('"referencesComplete":true', '"referencesComplete":false'),
        clear.replace('"status":"no-current-reference"', '"status":"in-use"'),
        clear.replace('"version":1', '"secret":"private-capability","version":1'),
      ]) {
        yield* Effect.flip(decode(stdout))
      }
    }).pipe(withTestCtx(test)),
  )

  it.effect(
    'retains lossless u64 strings and rejects overflow, numeric and noncanonical values',
    (test) =>
      Effect.gen(function* () {
        const stdout = (yield* fixtures)[2]!
        const lossless = stdout.replaceAll('"dev":"8"', '"dev":"18446744073709551615"')
        const decoded = yield* decode(lossless)
        expect(decoded.roots[0]!.identity?.dev).toBe('18446744073709551615')
        expect(decoded.roots[0]!.references[0]!.identity.dev).toBe('18446744073709551615')
        for (const value of ['"18446744073709551616"', '"08"', '8', '"-1"', '""']) {
          yield* Effect.flip(decode(stdout.replace('"dev":"8"', `"dev":${value}`)))
        }
        for (const invalid of [
          stdout.replace('"fd":7', '"fd":null'),
          stdout.replace('"tgid":41', '"tgid":0'),
          stdout.replace('"relativePath":"."', '"relativePath":"../escape"'),
          stdout.replace('"leaderStart":"100"', '"leaderStart":"0"'),
          stdout.replace('"uid":[1000,1000,1000,1000]', '"uid":[1000]'),
          stdout.replace('"reference":"fd"', '"reference":"cwd"'),
          stdout
            .replace('"reference":"fd"', '"reference":"cwd"')
            .replace('"fd":7', '"fd":null')
            .replace('"effect":"in-use"', '"effect":"retained-bytes"'),
        ])
          yield* Effect.flip(decode(invalid))
      }).pipe(withTestCtx(test)),
  )
})
