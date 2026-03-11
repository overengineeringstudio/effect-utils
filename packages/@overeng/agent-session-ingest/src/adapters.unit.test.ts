import { utimesSync } from 'node:fs'
import * as nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeClaudeAdapter } from './adapters/claude.ts'
import { makeCodexAdapter } from './adapters/codex.ts'
import { makeOpenCodeAdapter } from './adapters/opencode.ts'

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

  Vitest.it.effect('ingests Claude project transcripts incrementally', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const projectsRoot = nodePath.join(tempDir, 'projects')
      yield* fs.makeDirectory(nodePath.join(projectsRoot, 'repo', 'session'), {
        recursive: true,
      })

      const artifactPath = nodePath.join(projectsRoot, 'repo', 'session', 'main.jsonl')
      yield* fs.writeFileString(
        artifactPath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-03-10T10:00:00.000Z',
            sessionId: 'sess_1',
            content: 'hello',
          }),
          JSON.stringify({
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
          }),
          '',
        ].join('\n'),
      )

      const adapter = makeClaudeAdapter({ projectsRoot })
      const artifacts = yield* adapter.discoverArtifacts
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]
      if (artifact === undefined) {
        return yield* Effect.die('Expected Claude artifact to exist')
      }

      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(2)

      yield* fs.writeFileString(
        artifactPath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-03-10T10:00:00.000Z',
            sessionId: 'sess_1',
            content: 'hello',
          }),
          JSON.stringify({
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
          }),
          JSON.stringify({
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
          }),
          '',
        ].join('\n'),
      )

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })
      expect(second.records).toHaveLength(1)
      expect(second.records[0]?.type).toBe('progress')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  Vitest.it.effect('ingests OpenCode session rows incrementally from SQLite', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tempDir = yield* fs.makeTempDirectoryScoped()
      const databasePath = nodePath.join(tempDir, 'opencode.db')

      yield* Effect.sync(() => {
        const db = new DatabaseSync(databasePath)
        try {
          db.exec(`
            create table session (
              id text primary key,
              project_id text not null,
              parent_id text,
              slug text not null,
              directory text not null,
              title text not null,
              version text not null,
              share_url text,
              summary_additions integer,
              summary_deletions integer,
              summary_files integer,
              summary_diffs text,
              revert text,
              permission text,
              time_created integer not null,
              time_updated integer not null,
              time_compacting integer,
              time_archived integer,
              workspace_id text
            );
            create table message (
              id text primary key,
              session_id text not null,
              time_created integer not null,
              time_updated integer not null,
              data text not null
            );
            create table part (
              id text primary key,
              message_id text not null,
              session_id text not null,
              time_created integer not null,
              time_updated integer not null,
              data text not null
            );
          `)
          db.prepare(
            `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values (?, 'proj_1', ?, ?, ?, ?, ?, ?)`,
          ).run('ses_1', 'shiny-lagoon', '/tmp/repo', 'Demo session', '1.2.15', 1000, 1100)
          db.prepare(
            `insert into message (id, session_id, time_created, time_updated, data)
             values (?, ?, ?, ?, ?)`,
          ).run(
            'msg_1',
            'ses_1',
            1001,
            1101,
            JSON.stringify({
              role: 'assistant',
              time: { created: 1001, completed: 1002 },
              modelID: 'gpt-5.3-codex',
              providerID: 'openai',
            }),
          )
          db.prepare(
            `insert into part (id, message_id, session_id, time_created, time_updated, data)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(
            'prt_1',
            'msg_1',
            'ses_1',
            1002,
            1102,
            JSON.stringify({
              type: 'text',
              text: 'Done',
            }),
          )
        } finally {
          db.close()
        }
      })

      const adapter = makeOpenCodeAdapter({ databasePath })
      const artifacts = yield* adapter.discoverArtifacts
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]
      if (artifact === undefined) {
        return yield* Effect.die('Expected OpenCode artifact to exist')
      }

      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(3)
      expect(first.records[0]?._tag).toBe('OpenCodeSession')

      yield* Effect.sync(() => {
        const db = new DatabaseSync(databasePath)
        try {
          db.prepare(`update session set time_updated = ? where id = ?`).run(1200, 'ses_1')
          db.prepare(
            `insert into part (id, message_id, session_id, time_created, time_updated, data)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(
            'prt_2',
            'msg_1',
            'ses_1',
            1201,
            1201,
            JSON.stringify({
              type: 'step-finish',
              reason: 'stop',
            }),
          )
        } finally {
          db.close()
        }
      })

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })
      expect(second.records).toHaveLength(2)
      expect(second.records.map((record) => record._tag)).toEqual([
        'OpenCodeSession',
        'OpenCodePart',
      ])
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
