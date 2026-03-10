import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeCcSafetyNetAdapter } from './adapters/cc-safety-net.ts'
import { makeCodexAdapter } from './adapters/codex.ts'

const TestLayer = NodeContext.layer

Vitest.describe('agent-session-ingest adapters', () => {
  Vitest.it.effect('ingests Codex JSONL session records incrementally', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const sessionsRoot = nodePath.join(tempDir, 'sessions')
      yield* fs.makeDirectory(sessionsRoot, { recursive: true })

      const artifactPath = nodePath.join(sessionsRoot, 'rollout.jsonl')
      yield* fs.writeFileString(
        artifactPath,
        [
          JSON.stringify({
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_1',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'done',
            },
          }),
          '',
        ].join('\n'),
      )

      const adapter = makeCodexAdapter({ sessionsRoot })
      const artifacts = yield* adapter.discoverArtifacts
      const artifact = artifacts[0]
      expect(artifact).toBeDefined()
      if (artifact === undefined) {
        return yield* Effect.die('Expected Codex artifact to exist')
      }
      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(2)

      yield* fs.writeFileString(
        artifactPath,
        [
          JSON.stringify({
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_1',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'done',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-10T10:00:02.000Z',
            type: 'turn_context',
            payload: {
              cwd: '/tmp/repo',
            },
          }),
          '',
        ].join('\n'),
      )

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })
      expect(second.records).toHaveLength(1)
      expect(second.records[0]?.type).toBe('turn_context')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('ingests cc-safety-net records incrementally', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const logsDir = nodePath.join(tempDir, 'logs')
      yield* fs.makeDirectory(logsDir, { recursive: true })

      const artifactPath = nodePath.join(logsDir, 'safety.jsonl')
      yield* fs.writeFileString(
        artifactPath,
        `${JSON.stringify({
          ts: '2026-03-10T10:00:00.000Z',
          command: 'git commit',
          segment: 'git commit',
          reason: 'pre-commit hook hang suspected',
          cwd: '/tmp/repo',
        })}\n`,
      )

      const adapter = makeCcSafetyNetAdapter({ logsDir })
      const artifacts = yield* adapter.discoverArtifacts
      const artifact = artifacts[0]
      expect(artifact).toBeDefined()
      if (artifact === undefined) {
        return yield* Effect.die('Expected cc-safety-net artifact to exist')
      }
      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(1)

      yield* fs.writeFileString(
        artifactPath,
        [
          JSON.stringify({
            ts: '2026-03-10T10:00:00.000Z',
            command: 'git commit',
            segment: 'git commit',
            reason: 'pre-commit hook hang suspected',
            cwd: '/tmp/repo',
          }),
          JSON.stringify({
            ts: '2026-03-10T10:00:01.000Z',
            command: 'git commit --no-verify',
            segment: '--no-verify',
            reason: 'bypass used after tooling friction',
            cwd: '/tmp/repo',
          }),
          '',
        ].join('\n'),
      )

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })

      expect(second.records).toHaveLength(1)
      expect(second.records[0]?.command).toContain('--no-verify')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
