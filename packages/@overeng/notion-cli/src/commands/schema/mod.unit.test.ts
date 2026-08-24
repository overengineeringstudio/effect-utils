import { Command } from 'effect/unstable/cli'
import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { generateCommand } from './mod.ts'

/**
 * `schema generate` exposes both a file `--output`/`-o` option and the shared
 * TUI render-mode option. These used to collide: the render-mode option also
 * claimed `--output`/`-o`, so its choice validator shadowed the file path and
 * `generate <id> -o schema.gen.ts` was rejected as an invalid mode. The
 * render-mode flag now lives on `--output-mode` (no `-o` alias), leaving
 * `--output`/`-o` free for the file path.
 *
 * This is a parse-level test: we swap in a capturing handler so the real Args/
 * Options (where any collision lives) are exercised without touching the Notion
 * API or the network.
 */
describe('schema generate option resolution', () => {
  it.effect('parses -o as the output file path (no --output-mode collision)', () =>
    Effect.gen(function* () {
      let captured: { output?: string; tuiOutput?: string } | undefined

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
      // The TUI render mode falls back to its default rather than swallowing `-o`.
      expect(captured!.tuiOutput).toBe('auto')
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
