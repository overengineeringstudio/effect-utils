import { utimesSync } from 'node:fs'
import * as nodePath from 'node:path'

import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  TestLayer,
  expectSingleArtifact,
  makeTempJsonlArtifact,
  rewriteJsonlArtifact,
} from './adapters.integration-test-helpers.ts'
import { makeCodexAdapter } from './adapters/codex.ts'

Vitest.describe('codex adapter integration', () => {
  Vitest.it.effect('ingests Codex JSONL session records incrementally', () =>
    Effect.gen(function* () {
      const { root: sessionsRoot, artifactPath } = yield* makeTempJsonlArtifact({
        rootDirectoryName: 'sessions',
        relativeDirectory: '.',
        filename: 'rollout.jsonl',
        records: [
          {
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_1',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          },
          {
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'done',
            },
          },
        ],
      })

      const adapter = makeCodexAdapter({ sessionsRoot })
      const artifact = yield* expectSingleArtifact(adapter)
      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(2)

      yield* rewriteJsonlArtifact({
        path: artifactPath,
        records: [
          {
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_1',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          },
          {
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'done',
            },
          },
          {
            timestamp: '2026-03-10T10:00:02.000Z',
            type: 'turn_context',
            payload: {
              cwd: '/tmp/repo',
            },
          },
        ],
      })

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
      const { root: sessionsRoot } = yield* makeTempJsonlArtifact({
        rootDirectoryName: 'sessions',
        relativeDirectory: '.',
        filename: 'stale.jsonl',
        records: [
          {
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_stale',
              output: 'stale',
            },
          },
        ],
      })

      const recentArtifactPath = nodePath.join(sessionsRoot, 'recent.jsonl')
      yield* rewriteJsonlArtifact({
        path: recentArtifactPath,
        records: [
          {
            timestamp: '2026-03-10T10:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess_recent',
              timestamp: '2026-03-10T10:00:00.000Z',
              cwd: '/tmp/repo',
            },
          },
          {
            timestamp: '2026-03-10T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_recent',
              output: 'recent',
            },
          },
        ],
      })

      yield* Effect.sync(() => {
        const staleTime = new Date('2026-01-01T10:00:00.000Z')
        const recentTime = new Date('2026-03-10T10:00:00.000Z')
        utimesSync(nodePath.join(sessionsRoot, 'stale.jsonl'), staleTime, staleTime)
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
