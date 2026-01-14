/**
 * Inline renderer: Updates progress in-place, leaves output in terminal.
 *
 * Unlike alternate-screen mode, this renderer:
 * - Updates status lines in-place using cursor positioning
 * - Leaves the final output visible in the terminal history
 * - Works well in CI and interactive environments
 */

import * as Ansi from '@effect/printer-ansi/Ansi'
import * as AnsiDoc from '@effect/printer-ansi/AnsiDoc'
import * as Doc from '@effect/printer/Doc'
import { Console, Effect, Option } from 'effect'

import type { TaskRenderer, TaskSystemState } from '../types.ts'

/** Render an ANSI-annotated document to a string */
const renderAnsiDoc = (doc: Doc.Doc<Ansi.Ansi>): string => AnsiDoc.render(doc, { style: 'pretty' })

/** ANSI escape code to move cursor up N lines */
const moveCursorUp = (lines: number) => `\x1B[${lines}A`

/** ANSI escape code to clear from cursor to end of line */
const clearLine = '\x1B[K'

/**
 * Inline renderer that updates progress in-place.
 */
export class InlineRenderer implements TaskRenderer {
  private lastLineCount = 0

  render(state: TaskSystemState): Effect.Effect<void> {
    return Effect.gen(
      function* (this: InlineRenderer) {
        const tasks = Object.values(state.tasks)

        // Clear previous output (move cursor up and clear lines)
        if (this.lastLineCount > 0) {
          process.stdout.write(moveCursorUp(this.lastLineCount))
          for (let i = 0; i < this.lastLineCount; i++) {
            process.stdout.write(clearLine + '\n')
          }
          process.stdout.write(moveCursorUp(this.lastLineCount))
        }

        const docs: Doc.Doc<Ansi.Ansi>[] = []

        for (const task of tasks) {
          const statusStyle = {
            pending: Ansi.white,
            running: Ansi.cyan,
            success: Ansi.green,
            failed: Ansi.red,
          }[task.status]

          const statusIcon = {
            pending: '○',
            running: '◐',
            success: '✓',
            failed: '✗',
          }[task.status]

          const duration = Option.match(task.startedAt, {
            onNone: () => '',
            onSome: (start) =>
              Option.match(task.completedAt, {
                onNone: () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`,
                onSome: (end) => ` (${((end - start) / 1000).toFixed(1)}s)`,
              }),
          })

          const taskLine = Doc.cat(
            Doc.annotate(Doc.text(statusIcon), statusStyle),
            Doc.cat(Doc.text(` ${task.name}`), Doc.annotate(Doc.text(duration), Ansi.white)),
          )

          docs.push(taskLine)

          // Show last 1-2 lines of output for running or failed tasks
          if (task.status === 'running' || task.status === 'failed') {
            const allOutput = [...task.stdout, ...task.stderr]
            const recentLines = allOutput.slice(-2) // Last 2 lines

            for (const line of recentLines) {
              const truncated = line.length > 80 ? line.slice(0, 77) + '...' : line
              docs.push(Doc.annotate(Doc.text(`  │ ${truncated}`), Ansi.white))
            }
          }
        }

        const output = renderAnsiDoc(Doc.vsep(docs))
        const lines = output.split('\n')

        yield* Console.log(output)
        this.lastLineCount = lines.length
      }.bind(this),
    )
  }

  renderFinal(state: TaskSystemState): Effect.Effect<void> {
    return Effect.gen(function* () {
      const tasks = Object.values(state.tasks)
      const failed = tasks.filter((t) => t.status === 'failed')
      const success = tasks.filter((t) => t.status === 'success')

      yield* Console.log('') // Empty line before summary

      if (failed.length === 0) {
        const successDoc = Doc.annotate(
          Doc.text(`✓ All ${success.length} task(s) completed successfully`),
          Ansi.combine(Ansi.green, Ansi.bold),
        )
        yield* Console.log(renderAnsiDoc(successDoc))
      } else {
        const failureDoc = Doc.annotate(
          Doc.text(`✗ ${failed.length} task(s) failed`),
          Ansi.combine(Ansi.red, Ansi.bold),
        )
        yield* Console.log(renderAnsiDoc(failureDoc))

        // Show details for failed tasks
        for (const task of failed) {
          yield* Console.log('')
          const headerDoc = Doc.annotate(
            Doc.text(`--- ${task.name} ---`),
            Ansi.combine(Ansi.red, Ansi.bold),
          )
          yield* Console.log(renderAnsiDoc(headerDoc))

          // Show stderr if available
          if (task.stderr.length > 0) {
            for (const line of task.stderr) {
              yield* Console.log(line)
            }
          }

          // Show error message
          if (Option.isSome(task.error)) {
            yield* Console.log(`Error: ${task.error.value}`)
          }
        }
      }
    })
  }
}

/**
 * Create an inline renderer instance.
 */
export const inlineRenderer = (): TaskRenderer => new InlineRenderer()
