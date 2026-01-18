import fs from 'node:fs'
import path from 'node:path'

import { NodeContext } from '@effect/platform-node'
import * as CommandExecutor from '@effect/platform/CommandExecutor'
import { describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'

import { shouldNeverHappen } from '../isomorphic/mod.ts'
import { cmd } from './cmd.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

const TestLayer = Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)

describe('cmd helper', () => {
  const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

  it.effect('runs tokenized string without shell',
    Effect.fnUntraced(
      function* () {
        const exit = yield* cmd('printf ok')
        expect(exit).toBe(CommandExecutor.ExitCode(0))
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect('runs array input',
    Effect.fnUntraced(
      function* () {
        const exit = yield* cmd(['printf', 'ok'])
        expect(exit).toBe(CommandExecutor.ExitCode(0))
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect('supports logging with archive + retention',
    Effect.fnUntraced(
      function* () {
        const workspaceRoot =
          process.env.WORKSPACE_ROOT ?? shouldNeverHappen('WORKSPACE_ROOT is not set')
        const logsDir = path.join(workspaceRoot, 'tmp', 'cmd-tests', String(Date.now()))

        // first run
        const exit1 = yield* cmd('printf first', { logDir: logsDir })
        expect(exit1).toBe(CommandExecutor.ExitCode(0))
        const current = path.join(logsDir, 'dev.log')
        expect(fs.existsSync(current)).toBe(true)
        const firstLog = fs.readFileSync(current, 'utf8')
        const firstStdoutLines = firstLog.split('\n').filter((line) => line.includes('[stdout]'))
        expect(firstStdoutLines.length).toBeGreaterThan(0)
        for (const line of firstStdoutLines) {
          expect(line).toContain('[stdout] first')
          expect(line).toContain('INFO')
          expect(line).toContain('printf first')
        }

        // second run — archives previous
        const exit2 = yield* cmd('printf second', { logDir: logsDir })
        expect(exit2).toBe(CommandExecutor.ExitCode(0))
        const archiveDir = path.join(logsDir, 'archive')
        const archives = fs.readdirSync(archiveDir).filter((file) => file.endsWith('.log'))
        expect(archives.length).toBe(1)
        const archivedName = archives[0]
        if (!archivedName) throw new Error('Expected archive file')
        const archivedPath = path.join(archiveDir, archivedName)
        const archivedLog = fs.readFileSync(archivedPath, 'utf8')
        const archivedStdoutLines = archivedLog
          .split('\n')
          .filter((line) => line.includes('[stdout]'))
        expect(archivedStdoutLines.length).toBeGreaterThan(0)
        for (const line of archivedStdoutLines) {
          expect(line).toContain('[stdout] first')
        }

        const secondLog = fs.readFileSync(current, 'utf8')
        const secondStdoutLines = secondLog.split('\n').filter((line) => line.includes('[stdout]'))
        expect(secondStdoutLines.length).toBeGreaterThan(0)
        for (const line of secondStdoutLines) {
          expect(line).toContain('[stdout] second')
          expect(line).toContain('INFO')
        }

        // generate many archives to exercise retention (keep 50)
        for (let i = 0; i < 60; i++) {
          // Use small unique payloads
          yield* cmd(['printf', String(i)], { logDir: logsDir })
        }
        const archivesAfter = fs.readdirSync(archiveDir).filter((file) => file.endsWith('.log'))
        expect(archivesAfter.length).toBeLessThanOrEqual(50)
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect('streams stdout and stderr with logger formatting',
    Effect.fnUntraced(
      function* () {
        const workspaceRoot =
          process.env.WORKSPACE_ROOT ?? shouldNeverHappen('WORKSPACE_ROOT is not set')
        const logsDir = path.join(workspaceRoot, 'tmp', 'cmd-tests', `format-${Date.now()}`)

        const exit = yield* cmd(['bun', '-e', "console.log('out'); console.error('err')"], {
          logDir: logsDir,
        })
        expect(exit).toBe(CommandExecutor.ExitCode(0))

        const current = path.join(logsDir, 'dev.log')
        const logContent = fs.readFileSync(current, 'utf8')
        const strippedContent = logContent.replace(ansiRegex, '')
        expect(strippedContent).toMatch(/\[stdout] out/)
        expect(strippedContent).toMatch(/\[stderr] err/)

        const relevantLines = logContent
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('[stdout]') || line.includes('[stderr]'))

        expect(relevantLines.length).toBeGreaterThanOrEqual(2)

        for (const line of relevantLines) {
          const stripped = line.replace(ansiRegex, '')
          expect(stripped.startsWith('[')).toBe(true)
          expect(stripped).toMatch(/(INFO|WARN)/)
          expect(stripped).toMatch(/\[(stdout|stderr)]/)
        }
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  // TODO: Test timeouts with streaming processes - Effect.timeout doesn't interrupt stream-based I/O properly
  // when combined with scoped resources. This needs deeper investigation or a different approach.
  // For now, the core cleanup functionality is covered by acquireRelease in the cmd implementation.
})
