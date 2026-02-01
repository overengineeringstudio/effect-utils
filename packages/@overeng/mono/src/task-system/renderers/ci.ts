/**
 * CI renderer: Outputs GitHub Actions groups for collapsible task sections.
 *
 * This renderer:
 * - Uses GitHub Actions `::group::` and `::endgroup::` syntax
 * - Shows full output for each task within its group
 * - Works well in CI environments where in-place updates aren't supported
 */

import * as Ansi from '@effect/printer-ansi/Ansi'
import * as AnsiDoc from '@effect/printer-ansi/AnsiDoc'
import * as Doc from '@effect/printer/Doc'
import { Console, Effect, Option } from 'effect'

import { unicodeSymbols } from '@overeng/tui-core'

import type { TaskRenderer, TaskSystemState } from '../types.ts'

/** Render an ANSI-annotated document to a string */
const renderAnsiDoc = (doc: Doc.Doc<Ansi.Ansi>): string => AnsiDoc.render(doc, { style: 'pretty' })

/**
 * CI renderer that outputs GitHub Actions groups.
 */
export class CIRenderer implements TaskRenderer {
  private completedTasks = new Set<string>()

  render(state: TaskSystemState): Effect.Effect<void> {
    return Effect.gen(
      function* (this: CIRenderer) {
        const tasks = Object.values(state.tasks)

        for (const task of tasks) {
          // Skip tasks we've already processed
          if (this.completedTasks.has(task.id)) {
            continue
          }

          // Only output when task starts running
          if (task.status === 'running' && !this.completedTasks.has(`${task.id}-started`)) {
            yield* Console.log(`::group::${task.name}`)
            this.completedTasks.add(`${task.id}-started`)
          }

          // Output task completion
          if (task.status === 'success' || task.status === 'failed') {
            // Show all stdout/stderr
            for (const line of task.stdout) {
              yield* Console.log(line)
            }
            for (const line of task.stderr) {
              yield* Console.error(line)
            }

            // Show error if failed
            if (task.status === 'failed' && Option.isSome(task.error)) {
              yield* Console.error(`Error: ${task.error.value}`)
            }

            const duration = Option.match(task.startedAt, {
              onNone: () => '',
              onSome: (start) =>
                Option.match(task.completedAt, {
                  onNone: () => '',
                  onSome: (end) => ` (${((end - start) / 1000).toFixed(1)}s)`,
                }),
            })

            const statusIcon =
              task.status === 'success' ? unicodeSymbols.status.check : unicodeSymbols.status.cross
            const statusStyle = task.status === 'success' ? Ansi.green : Ansi.red
            const statusDoc = Doc.annotate(
              Doc.text(`${statusIcon} ${task.name}${duration}`),
              Ansi.combine(statusStyle, Ansi.bold),
            )

            yield* Console.log(renderAnsiDoc(statusDoc))
            yield* Console.log('::endgroup::')

            this.completedTasks.add(task.id)
          }
        }
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
          Doc.text(
            `${unicodeSymbols.status.check} All ${success.length} task(s) completed successfully`,
          ),
          Ansi.combine(Ansi.green, Ansi.bold),
        )
        yield* Console.log(renderAnsiDoc(successDoc))
      } else {
        const failureDoc = Doc.annotate(
          Doc.text(`${unicodeSymbols.status.cross} ${failed.length} task(s) failed`),
          Ansi.combine(Ansi.red, Ansi.bold),
        )
        yield* Console.log(renderAnsiDoc(failureDoc))
      }
    })
  }
}

/**
 * Create a CI renderer instance.
 */
export const ciRenderer = (): TaskRenderer => new CIRenderer()
