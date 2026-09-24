import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Option } from 'effect'
import { Command } from 'effect/unstable/cli'
import { expect } from 'vitest'

import { CurrentWorkingDirectory } from '@overeng/utils/node'

import { generateCommand } from './mod.ts'

/**
 * `schema generate` exposes both a file `--output`/`-o` option and TUI render
 * flags. The render mode lives on `--output-mode` (no `-o` alias), leaving
 * `--output`/`-o` free for the file path. `--json` remains available as the
 * shorthand for JSON rendering and conflicts with an explicit `--output-mode`.
 *
 * This is a parse-level test: we swap in a capturing handler so the real Args/
 * Options (where any collision lives) are exercised without touching the Notion
 * API or the network.
 */
describe('schema generate option resolution', () => {
  it.effect('parses -o as the output file path (no --output-mode collision)', () =>
    Effect.gen(function* () {
      let captured:
        | {
            output?: string
            tuiOutput?: Option.Option<string>
            json?: Option.Option<boolean>
          }
        | undefined

      const testCommand = Command.withHandler(generateCommand, (parsed) =>
        Effect.sync(() => {
          captured = parsed
        }),
      )

      const runCli = Command.runWith(testCommand, { version: 'test' })

      yield* runCli(['db-id-123', '-o', 'schema.gen.ts'])

      expect(captured).toBeDefined()
      // Effect v4 `Options.file` resolves the value against the process cwd.
      expect(captured!.output!.endsWith('schema.gen.ts')).toBe(true)
      // The TUI render flags remain absent rather than swallowing `-o`.
      expect(Option.isNone(captured!.tuiOutput!)).toBe(true)
      expect(Option.isNone(captured!.json!)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('rejects --json together with an explicit --output-mode', () =>
    Effect.gen(function* () {
      const runCli = Command.runWith(generateCommand, { version: 'test' })
      const exit = yield* runCli([
        'db-id-123',
        '--output',
        'schema.gen.ts',
        '--output-mode',
        'ci',
        '--json',
      ]).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) === true) {
        expect(Cause.pretty(exit.cause)).toContain('--output-mode and --json')
      }
    }).pipe(Effect.provide([NodeServices.layer, CurrentWorkingDirectory.live])),
  )
})
