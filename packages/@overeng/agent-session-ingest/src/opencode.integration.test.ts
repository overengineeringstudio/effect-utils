import * as nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { TestLayer, expectSingleArtifact } from './adapters.integration-test-helpers.ts'
import { makeOpenCodeAdapter } from './adapters/opencode.ts'

Vitest.describe('opencode adapter integration', () => {
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
              modelID: 'gpt-5',
              providerID: 'openai',
              path: { cwd: '/tmp/repo', root: '/tmp' },
            }),
          )
          db.prepare(
            `insert into part (id, message_id, session_id, time_created, time_updated, data)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(
            'part_1',
            'msg_1',
            'ses_1',
            1002,
            1102,
            JSON.stringify({
              type: 'tool',
              callID: 'call_1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo hi' },
                output: 'hi',
              },
            }),
          )
        } finally {
          db.close()
        }
      })

      const adapter = makeOpenCodeAdapter({ databasePath })
      const artifact = yield* expectSingleArtifact(adapter)
      const first = yield* adapter.ingestArtifact({ artifact, checkpoint: undefined })
      expect(first.records).toHaveLength(3)

      yield* Effect.sync(() => {
        const db = new DatabaseSync(databasePath)
        try {
          db.prepare(
            `insert into part (id, message_id, session_id, time_created, time_updated, data)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(
            'part_2',
            'msg_1',
            'ses_1',
            1003,
            1200,
            JSON.stringify({
              type: 'step-finish',
              reason: 'completed',
            }),
          )
          db.prepare(`update session set time_updated = ? where id = ?`).run(1200, 'ses_1')
        } finally {
          db.close()
        }
      })

      const second = yield* adapter.ingestArtifact({
        artifact,
        checkpoint: first.checkpoint,
      })
      expect(second.records).toHaveLength(2)
      expect(second.records[0]?._tag).toBe('OpenCodeSession')
      expect(second.records[1]?._tag).toBe('OpenCodePart')
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
