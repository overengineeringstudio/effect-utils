import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  captureWorktreeHolderEvidence,
  isWorktreeHolderEvidenceFresh,
} from './store-worktree-holder-client.ts'
import { WorktreeHolderEvidenceSchema } from './store-worktree-holder-codec.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url))
const actualCodecFrame = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const line = (yield* fs.readFileString(fixturePath)).split('\n')[0]!
  return yield* Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema), {
    onExcessProperty: 'error',
  })(line)
})

describe('native holder evidence client fail-closed boundary', () => {
  it.effect('rejects a producer frame bound to a different actual host, or missing Linux identity files', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const frame = yield* actualCodecFrame
      const machineId = yield* fs.readFile('/etc/machine-id').pipe(Effect.option)
      const actualHost = machineId._tag === 'Some'
        ? createHash('sha256').update(machineId.value).digest('hex')
        : undefined
      const differentHost = actualHost === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64)
      expect(yield* isWorktreeHolderEvidenceFresh({ ...frame, hostId: differentHost })).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('rejects invalid client identity and request scope without authorizing a fallback collector', () =>
    Effect.gen(function* () {
      const frame = yield* actualCodecFrame
      const client = {
        path: `${frame.producerId}/bin/worktree-holder-evidence`,
        producerId: frame.producerId,
        policyId: frame.policyId,
      }
      const root = frame.roots[0]!.path
      for (const paths of [[], ['/'], [root, root]]) {
        expect(yield* captureWorktreeHolderEvidence({ client, paths })).toBeUndefined()
      }
      expect(yield* captureWorktreeHolderEvidence({
        client: { ...client, path: '/bin/false' }, paths: [root],
      })).toBeUndefined()
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
