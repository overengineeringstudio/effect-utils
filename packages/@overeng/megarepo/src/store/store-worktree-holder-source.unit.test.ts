import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { WorktreeHolderEvidenceSchema } from './store-worktree-holder-codec.ts'
import {
  classifyWorktreeHolderEvidence,
  makeWorktreeHolderSource,
} from './store-worktree-holder-source.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url))
const actualFrames = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const lines = (yield* fs.readFileString(fixturePath)).trimEnd().split('\n')
  expect(lines).toHaveLength(9)
  return yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema), {
      onExcessProperty: 'error',
    })(line),
  )
})

// Pure policy over actual codec bytes, not a substituted successful native capture.
describe('scoped worktree holder policy', () => {
  it.effect('vetoes actual retained fd, map and executable references even when native status is clear', () =>
    Effect.gen(function* () {
      const frame = (yield* actualFrames)[7]!
      const root = frame.roots[0]!
      expect(root.status).toBe('no-current-reference')
      expect(root.references.map((reference) => reference.reference)).toEqual(['fd', 'map', 'exe'])
      const observed = classifyWorktreeHolderEvidence({
        evidence: frame, worktreePath: root.path, admitted: true,
        ownUid: root.references[0]!.uid[0],
        ignoredProcesses: root.references.map((reference) => ({
          pid: reference.tgid, startTime: reference.leaderStart,
        })),
      })
      expect(observed.complete).toBe(true)
      expect(observed.inUse._tag).toBe('in-use')
      expect(observed.references).toHaveLength(3)
      expect(observed.excludedProcesses).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('does not exempt a real nonleader cwd merely because its leader lifetime is selected', () =>
    Effect.gen(function* () {
      const frame = (yield* actualFrames)[6]!
      const root = frame.roots[0]!
      const reference = root.references[0]!
      expect(reference.reference).toBe('cwd')
      expect(reference.tid).not.toBe(reference.tgid)
      expect(reference.taskStart).not.toBe(reference.leaderStart)
      expect(new Set(reference.uid).size).toBe(1)
      const observed = classifyWorktreeHolderEvidence({
        evidence: frame, worktreePath: root.path, admitted: true,
        ownUid: reference.uid[0],
        ignoredProcesses: [{ pid: reference.tgid, startTime: reference.leaderStart }],
      })
      expect(observed.excludedProcesses).toEqual([])
      expect(observed.inUse._tag).toBe('in-use')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('never classifies an unadmitted or uncovered scope as free', () =>
    Effect.gen(function* () {
      const frames = yield* actualFrames
      for (const frame of frames) for (const root of frame.roots) {
        const observed = classifyWorktreeHolderEvidence({
          evidence: frame, worktreePath: root.path, admitted: false, ownUid: undefined,
        })
        expect(observed.complete).toBe(false)
        expect(observed.inUse._tag).not.toBe('free')
      }
      const frame = frames[5]!
      for (const worktreePath of [frame.roots[1]!.path, '/srv/worktrees/unrequested']) {
        const observed = classifyWorktreeHolderEvidence({
          evidence: frame, worktreePath, admitted: true, ownUid: undefined,
        })
        expect(observed.complete).toBe(false)
        expect(observed.inUse._tag).toBe('unknown')
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('keeps requested and unrequested roots unknown after rejected native capture', () =>
    Effect.gen(function* () {
      const frame = (yield* actualFrames)[0]!
      const source = yield* makeWorktreeHolderSource({
        client: {
          path: `${frame.producerId}/bin/worktree-holder-evidence`,
          producerId: frame.producerId, policyId: frame.policyId,
        },
        paths: ['/'],
      })
      for (const worktreePath of [frame.roots[0]!.path, '/srv/worktrees/unrequested']) {
        const observed = yield* source.read({ worktreePath })
        expect(observed.complete).toBe(false)
        expect(observed.inUse._tag).toBe('unknown')
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
