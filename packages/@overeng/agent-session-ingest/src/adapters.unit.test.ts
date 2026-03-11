import { utimesSync } from 'node:fs'
import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

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
      const record = second.records[0]
      expect(record !== undefined && 'type' in record ? record.type : undefined).toBe(
        'turn_context',
      )
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('filters stale Codex artifacts and seeds large first reads from the tail', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const sessionsRoot = nodePath.join(tempDir, 'sessions')
      yield* fs.makeDirectory(sessionsRoot, { recursive: true })

      const staleArtifactPath = nodePath.join(sessionsRoot, 'stale.jsonl')
      const recentArtifactPath = nodePath.join(sessionsRoot, 'recent.jsonl')

      yield* fs.writeFileString(
        staleArtifactPath,
        `${JSON.stringify({
          timestamp: '2026-01-01T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_stale',
            output: 'stale',
          },
        })}\n`,
      )
      yield* fs.writeFileString(
        recentArtifactPath,
        [
          JSON.stringify({
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_recent',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_recent',
              output: 'recent',
            },
          }),
          '',
        ].join('\n'),
      )

      yield* Effect.sync(() => {
        const staleTime = new Date('2026-01-01T10:00:00.000Z')
        const recentTime = new Date('2026-03-10T10:00:00.000Z')
        utimesSync(staleArtifactPath, staleTime, staleTime)
        utimesSync(recentArtifactPath, recentTime, recentTime)
      })

      const adapter = makeCodexAdapter({
        sessionsRoot,
        discoverySinceEpochMs: Date.parse('2026-03-01T00:00:00.000Z'),
        initialReadMaxBytes: 180,
      })
      const artifacts = yield* adapter.discoverArtifacts

      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]?.artifactId).toBe('recent')

      const artifact = artifacts[0]
      if (artifact === undefined) {
        return yield* Effect.die('Expected recent Codex artifact to exist')
      }

      const ingested = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(ingested.records).toHaveLength(1)
      const record = ingested.records[0]
      expect(
        record !== undefined && 'payload' in record ? record.payload : undefined,
      ).toMatchObject({
        type: 'function_call_output',
        output: 'recent',
      })
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
