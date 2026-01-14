/**
 * Example demonstrating the task system with real commands.
 *
 * Run with: bun packages/@overeng/mono/src/task-system/example.ts
 */

import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'

import { task } from './api.ts'
import { runTaskGraph, runTaskGraphOrFail } from './graph.ts'
import { inlineRenderer } from './renderers/inline.ts'

// =============================================================================
// Example 1: Task Graph with Dependencies
// =============================================================================

/**
 * Example task graph with dependencies:
 *
 *   setup-a  setup-b
 *      \      /
 *       check
 *        |
 *      report
 */
const exampleTasks = [
  // Create test directories in parallel
  task({
    id: 'setup-a',
    name: 'Setup directory A',
    command: {
      cmd: 'sh',
      args: [
        '-c',
        'mkdir -p tmp/task-example/a && echo "Setting up A..." && sleep 1 && echo "A ready"',
      ],
    },
  }),

  task({
    id: 'setup-b',
    name: 'Setup directory B',
    command: {
      cmd: 'sh',
      args: [
        '-c',
        'mkdir -p tmp/task-example/b && echo "Setting up B..." && sleep 0.5 && echo "B ready"',
      ],
    },
  }),

  // Check both directories exist (depends on both setups)
  task({
    id: 'check',
    name: 'Verify setup',
    command: {
      cmd: 'sh',
      args: [
        '-c',
        'test -d tmp/task-example/a && test -d tmp/task-example/b && echo "All directories exist" && ls -la tmp/task-example',
      ],
    },
    options: { dependencies: ['setup-a', 'setup-b'] },
  }),

  // Generate report (depends on check)
  task({
    id: 'report',
    name: 'Generate report',
    effect: Effect.gen(function* () {
      yield* Effect.log('Generating final report...')
      yield* Effect.sleep(500)
      yield* Effect.log('Report complete!')
    }),
    options: { dependencies: ['check'] },
  }),
] as const

// =============================================================================
// Example 2: Task Graph with Failure
// =============================================================================

/**
 * Example with a failing task to demonstrate error handling.
 */
const exampleWithFailure = [
  task({
    id: 'format',
    name: 'Format code',
    command: {
      cmd: 'sh',
      args: ['-c', 'echo "Formatting..." && sleep 0.5 && echo "Format complete"'],
    },
  }),

  task({
    id: 'lint',
    name: 'Lint code',
    command: {
      cmd: 'sh',
      args: [
        '-c',
        'echo "Linting..." && sleep 0.5 && >&2 echo "Error: Found lint issues" && exit 1',
      ],
    },
  }),

  task({
    id: 'typecheck',
    name: 'Type check',
    command: {
      cmd: 'sh',
      args: ['-c', 'echo "Type checking..." && sleep 1 && echo "Type check passed"'],
    },
  }),
] as const

// =============================================================================
// Main Program
// =============================================================================

const program = Effect.gen(function* () {
  console.log('=== Example 1: Task Graph with Dependencies ===\n')

  const renderer = inlineRenderer()

  // Run task graph with inline rendering
  const result1 = yield* runTaskGraphOrFail({
    tasks: exampleTasks,
    options: {
      onStateChange: (state) => renderer.render(state),
    },
  })

  yield* renderer.renderFinal(result1.state)

  console.log('\n\n=== Example 2: Task Graph with Failure ===\n')

  const renderer2 = inlineRenderer()

  // Run task graph with failure (will return result with failures)
  const result2 = yield* runTaskGraph({
    tasks: exampleWithFailure,
    options: {
      onStateChange: (state) => renderer.render(state),
    },
  })

  yield* renderer2.renderFinal(result2.state)

  if (result2.failureCount > 0) {
    yield* Effect.log(`${result2.failureCount} task(s) failed: ${result2.failedTaskIds.join(', ')}`)
  }

  // Cleanup
  console.log('\nCleaning up...')
  yield* Effect.promise(() =>
    import('node:fs/promises').then((fs) =>
      fs.rm('tmp/task-example', { recursive: true, force: true }),
    ),
  )
})

// Run the program with NodeContext (provides CommandExecutor)
Effect.runPromise(
  program.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<void, never, never>,
).catch(console.error)
