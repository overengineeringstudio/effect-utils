/**
 * Tests for inline renderer to prevent duplicate rendering and verify log lines.
 */

import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Console, Effect, Ref } from 'effect'
import { expect } from 'vitest'

import { task } from '../api.ts'
import { runTaskGraph, runTaskGraphOrFail } from '../graph.ts'
import { inlineRenderer } from './inline.ts'

/** Capture console output for testing */
const captureConsoleOutput = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const outputRef = yield* Ref.make<string[]>([])

    const testConsole: Console.Console = {
      [Console.TypeId]: Console.TypeId,
      log: (...args: ReadonlyArray<unknown>) =>
        Ref.update(outputRef, (lines) => [...lines, args.map(String).join(' ')]),
      error: (...args: ReadonlyArray<unknown>) =>
        Ref.update(outputRef, (lines) => [...lines, `[ERROR] ${args.map(String).join(' ')}`]),
      warn: (...args: ReadonlyArray<unknown>) =>
        Ref.update(outputRef, (lines) => [...lines, `[WARN] ${args.map(String).join(' ')}`]),
      clear: Effect.void,
      assert: () => Effect.void,
      count: () => Effect.void,
      countReset: () => Effect.void,
      debug: () => Effect.void,
      dir: () => Effect.void,
      dirxml: () => Effect.void,
      group: () => Effect.void,
      groupEnd: Effect.void,
      info: () => Effect.void,
      table: () => Effect.void,
      time: () => Effect.void,
      timeEnd: () => Effect.void,
      timeLog: () => Effect.void,
      trace: () => Effect.void,
      unsafe: globalThis.console,
    }

    const captureLayer = Console.setConsole(testConsole)

    const result = yield* effect.pipe(Effect.provide(captureLayer))
    const output = yield* Ref.get(outputRef)

    return { result, output }
  })

const withTestCtx = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<A, E, never>

describe('Inline renderer', () => {
  it.live(
    'does not duplicate task list between live updates and final summary',
    () =>
      withTestCtx(
        captureConsoleOutput(
          Effect.gen(function* () {
            const renderer = inlineRenderer()

            const tasks = [
              task('fast1', 'Fast task 1', {
                cmd: 'echo',
                args: ['task1'],
              }),
              task('fast2', 'Fast task 2', {
                cmd: 'echo',
                args: ['task2'],
              }),
            ]

            const result = yield* runTaskGraphOrFail(tasks, {
              onStateChange: (state) => renderer.render(state),
            })

            yield* renderer.renderFinal(result.state)

            return result
          }),
        ).pipe(
          Effect.map(({ output }) => {
            // Each task should appear in final render (1 time)
            // Plus potentially in live updates (depends on timing, but should be minimal)
            // The key is: after final render, we should not see duplicate task lists

            // Get lines after the final render (after blank line + summary)
            const summaryLineIndex = output.findIndex(
              (line) => line.includes('All') && line.includes('completed'),
            )

            // There should be no task lines after the summary
            const linesAfterSummary = output.slice(summaryLineIndex + 1)
            const taskLinesAfterSummary = linesAfterSummary.filter(
              (line) => line.includes('Fast task 1') || line.includes('Fast task 2'),
            )

            expect(taskLinesAfterSummary.length).toBe(0)
          }),
        ),
      ),
    30000,
  )

  it.live(
    'shows log lines for failed tasks',
    () =>
      withTestCtx(
        captureConsoleOutput(
          Effect.gen(function* () {
            const renderer = inlineRenderer()

            const tasks = [
              task('failing', 'Failing task', {
                cmd: 'sh',
                args: [
                  '-c',
                  'echo "Line 1" && echo "Line 2" && echo "Line 3" && >&2 echo "ERROR" && exit 1',
                ],
              }),
            ]

            const result = yield* runTaskGraph(tasks, {
              onStateChange: (state) => renderer.render(state),
            })

            yield* renderer.renderFinal(result.state)

            return result
          }),
        ).pipe(
          Effect.map(({ output }) => {
            // Find the final render (after completion)
            const finalOutput = output.join('\n')

            // Should show task with failed status
            expect(finalOutput).toContain('Failing task')

            // Should show last 2 lines of output with │ prefix
            // Note: Due to ANSI codes, we look for the │ character
            const logLineCount = output.filter((line) => line.includes('│')).length

            // Should have exactly 2 log lines (last 2 lines of output)
            expect(logLineCount).toBe(2)

            // Should show either stdout or stderr in log lines
            const hasOutputInLogLines = output.some(
              (line) => line.includes('│') && (line.includes('Line') || line.includes('ERROR')),
            )
            expect(hasOutputInLogLines).toBe(true)
          }),
        ),
      ),
    30000,
  )

  it.live(
    'truncates long log lines at 80 characters',
    () =>
      withTestCtx(
        captureConsoleOutput(
          Effect.gen(function* () {
            const renderer = inlineRenderer()

            const longLine = 'x'.repeat(100)
            const tasks = [
              task('long-output', 'Long output task', {
                cmd: 'sh',
                args: ['-c', `echo "${longLine}" && exit 1`],
              }),
            ]

            const result = yield* runTaskGraph(tasks, {
              onStateChange: (state) => renderer.render(state),
            })

            yield* renderer.renderFinal(result.state)

            return result
          }),
        ).pipe(
          Effect.map(({ output }) => {
            // Find log lines (lines with │)
            const logLines = output.filter((line) => line.includes('│'))

            // Each log line should be truncated (contain ...)
            const hasTruncation = logLines.some((line) => line.includes('...'))
            expect(hasTruncation).toBe(true)

            // No log line should be extremely long (accounting for ANSI codes and prefix)
            const allReasonablyShort = logLines.every((line) => line.length < 200)
            expect(allReasonablyShort).toBe(true)
          }),
        ),
      ),
    30000,
  )

  it.live(
    'does not show log lines for successful tasks',
    () =>
      withTestCtx(
        captureConsoleOutput(
          Effect.gen(function* () {
            const renderer = inlineRenderer()

            const tasks = [
              task('success', 'Success task', {
                cmd: 'echo',
                args: ['completed'],
              }),
            ]

            const result = yield* runTaskGraphOrFail(tasks, {
              onStateChange: (state) => renderer.render(state),
            })

            yield* renderer.renderFinal(result.state)

            return result
          }),
        ).pipe(
          Effect.map(({ output }) => {
            const finalOutput = output.join('\n')

            // Should show task
            expect(finalOutput).toContain('Success task')

            // Should NOT show log lines (no │) since task succeeded
            const hasLogLines = output.some(
              (line) => line.includes('│') && line.includes('completed'),
            )
            expect(hasLogLines).toBe(false)
          }),
        ),
      ),
    30000,
  )

  it.live(
    'shows summary message after task list',
    () =>
      withTestCtx(
        captureConsoleOutput(
          Effect.gen(function* () {
            const renderer = inlineRenderer()

            const tasks = [
              task('task1', 'Task 1', {
                cmd: 'echo',
                args: ['done'],
              }),
              task('task2', 'Task 2', {
                cmd: 'sh',
                args: ['-c', 'exit 1'],
              }),
            ]

            const result = yield* runTaskGraph(tasks, {
              onStateChange: (state) => renderer.render(state),
            })

            yield* renderer.renderFinal(result.state)

            return result
          }),
        ).pipe(
          Effect.map(({ output }) => {
            // Find task lines
            const task1Index = output.findIndex((line) => line.includes('Task 1'))
            const task2Index = output.findIndex((line) => line.includes('Task 2'))

            // Find summary line
            const summaryIndex = output.findIndex((line) => line.includes('failed'))

            // Summary should come after task lines
            expect(summaryIndex).toBeGreaterThan(task1Index)
            expect(summaryIndex).toBeGreaterThan(task2Index)

            // Summary should mention failure
            const summaryLine = output[summaryIndex]
            expect(summaryLine).toContain('1')
            expect(summaryLine).toContain('failed')
          }),
        ),
      ),
    30000,
  )
})
