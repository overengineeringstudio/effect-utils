import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  appendJsonlArtifact,
  TestLayer,
  expectSingleArtifact,
  makeTempJsonlArtifact,
} from './adapters.integration-test-helpers.ts'
import { makeClaudeAdapter } from './adapters/claude.ts'

Vitest.describe('claude adapter integration', () => {
  Vitest.it.effect('ingests Claude project transcripts incrementally', () =>
    Effect.gen(function* () {
      const { root: projectsRoot, artifactPath } = yield* makeTempJsonlArtifact({
        rootDirectoryName: 'projects',
        relativeDirectory: 'repo/session',
        filename: 'main.jsonl',
        records: [
          {
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-03-10T10:00:00.000Z',
            sessionId: 'sess_1',
            content: 'hello',
          },
          {
            type: 'user',
            parentUuid: null,
            isSidechain: false,
            userType: 'external',
            cwd: '/tmp/repo',
            sessionId: 'sess_1',
            version: '2.1.70',
            uuid: 'u_1',
            timestamp: '2026-03-10T10:00:01.000Z',
            message: { role: 'user', content: 'hello' },
          },
        ],
      })

      const adapter = makeClaudeAdapter({ projectsRoot })
      const artifact = yield* expectSingleArtifact(adapter)
      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(2)

      yield* appendJsonlArtifact({
        path: artifactPath,
        records: [
          {
            type: 'progress',
            parentUuid: 'u_1',
            isSidechain: false,
            userType: 'external',
            cwd: '/tmp/repo',
            sessionId: 'sess_1',
            version: '2.1.70',
            uuid: 'p_1',
            timestamp: '2026-03-10T10:00:02.000Z',
            data: { type: 'hook_progress', hookEvent: 'PostToolUse' },
          },
        ],
      })

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })
      expect(second.records).toHaveLength(1)
      expect(second.records[0]?.type).toBe('progress')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('skips incomplete trailing Claude JSONL records', () =>
    Effect.gen(function* () {
      const { root: projectsRoot, artifactPath } = yield* makeTempJsonlArtifact({
        rootDirectoryName: 'projects',
        relativeDirectory: 'repo/subagents',
        filename: 'agent.jsonl',
        records: [
          {
            type: 'system',
            parentUuid: null,
            isSidechain: true,
            cwd: '/tmp/repo',
            sessionId: 'sess_2',
            version: '2.1.70',
            uuid: 'sys_1',
            timestamp: '2026-03-10T10:00:00.000Z',
            content: 'ready',
          },
        ],
      })

      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(
        artifactPath,
        `${JSON.stringify({
          type: 'system',
          parentUuid: null,
          isSidechain: true,
          cwd: '/tmp/repo',
          sessionId: 'sess_2',
          version: '2.1.70',
          uuid: 'sys_1',
          timestamp: '2026-03-10T10:00:00.000Z',
          content: 'ready',
        })}\n{"type":"assistant","sessionId":"sess_2"`,
      )

      const adapter = makeClaudeAdapter({ projectsRoot })
      const artifact = yield* expectSingleArtifact(adapter)
      const ingested = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(ingested.records).toHaveLength(1)
      expect(ingested.records[0]?.type).toBe('system')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
