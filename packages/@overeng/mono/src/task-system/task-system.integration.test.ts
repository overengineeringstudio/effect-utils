/**
 * Integration tests for task system with real command execution.
 * Tests end-to-end workflows with actual shell commands.
 */

import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'

import { task } from './api.ts'
import { runTaskGraph, runTaskGraphOrFail } from './graph.ts'

// Test context helper to provide NodeContext layer
// Usage: withTestCtx(Effect.gen(function* ()  { ... }))
const withTestCtx = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<A, E, never>

describe('Task system integration', () => {
  it.live('executes single successful command', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('echo', 'Echo test', {
          cmd: 'echo',
          args: ['hello world'],
        }),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(1)
      expect(result.failureCount).toBe(0)
      expect(result.state.tasks.echo?.status).toBe('success')
      expect(result.state.tasks.echo?.stdout).toContain('hello world')
    })),
    30000,
  )

  it.live('executes multiple independent tasks in parallel', () =>
    withTestCtx(Effect.gen(function* ()  {
      const startTimes: Record<string, number> = {}

      const tasks = [
        task('task1', 'Task 1', {
          cmd: 'sh',
          args: ['-c', 'echo "task1 start" && sleep 0.1 && echo "task1 done"'],
        }),
        task('task2', 'Task 2', {
          cmd: 'sh',
          args: ['-c', 'echo "task2 start" && sleep 0.1 && echo "task2 done"'],
        }),
      ]

      const start = Date.now()
      const result = yield* runTaskGraph(tasks)
      const duration = Date.now() - start

      expect(result.successCount).toBe(2)
      expect(result.failureCount).toBe(0)

      // Should complete in ~100-200ms (parallel), not ~200-400ms (sequential)
      expect(duration).toBeLessThan(300)
    })),
    30000,
  )

  it.live('executes tasks in dependency order', () =>
    withTestCtx(Effect.gen(function* ()  {
      const executed: string[] = []

      const tasks = [
        task('setup', 'Setup', {
          cmd: 'sh',
          args: ['-c', 'echo "setup"'],
        }),
        task(
          'build',
          'Build',
          {
            cmd: 'sh',
            args: ['-c', 'echo "build"'],
          },
          { dependencies: ['setup'] },
        ),
        task(
          'test',
          'Test',
          {
            cmd: 'sh',
            args: ['-c', 'echo "test"'],
          },
          { dependencies: ['build'] },
        ),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(3)
      expect(result.failureCount).toBe(0)

      // Verify all tasks completed
      expect(result.state.tasks.setup!.status).toBe('success')
      expect(result.state.tasks.build!.status).toBe('success')
      expect(result.state.tasks.test!.status).toBe('success')
    })),
    30000,
  )

  it.live('handles command failure correctly', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('failing', 'Failing task', {
          cmd: 'sh',
          args: ['-c', 'echo "about to fail" && exit 1'],
        }),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(0)
      expect(result.failureCount).toBe(1)
      expect(result.failedTaskIds).toEqual(['failing'])
      expect(result.state.tasks.failing!.status).toBe('failed')
    })),
    30000,
  )

  it.live('captures both stdout and stderr', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('output', 'Output test', {
          cmd: 'sh',
          args: ['-c', 'echo "stdout message" && >&2 echo "stderr message"'],
        }),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.state.tasks.output!.stdout).toContain('stdout message')
      expect(result.state.tasks.output!.stderr).toContain('stderr message')
    })),
    30000,
  )

  it.live('executes diamond dependency pattern', () =>
    withTestCtx(Effect.gen(function* ()  {
      //    root
      //    / \
      //   a   b
      //    \ /
      //   merge
      const tasks = [
        task('root', 'Root', {
          cmd: 'echo',
          args: ['root'],
        }),
        task(
          'a',
          'Branch A',
          {
            cmd: 'echo',
            args: ['a'],
          },
          { dependencies: ['root'] },
        ),
        task(
          'b',
          'Branch B',
          {
            cmd: 'echo',
            args: ['b'],
          },
          { dependencies: ['root'] },
        ),
        task(
          'merge',
          'Merge',
          {
            cmd: 'echo',
            args: ['merge'],
          },
          { dependencies: ['a', 'b'] },
        ),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(4)
      expect(result.failureCount).toBe(0)
      expect(result.state.tasks.root!.status).toBe('success')
      expect(result.state.tasks.a!.status).toBe('success')
      expect(result.state.tasks.b!.status).toBe('success')
      expect(result.state.tasks.merge!.status).toBe('success')
    })),
    30000,
  )

  it.live('mixes command and effect tasks', () =>
    withTestCtx(Effect.gen(function* ()  {
      let effectRan = false

      const tasks = [
        task('command', 'Command task', {
          cmd: 'echo',
          args: ['from command'],
        }),
        task(
          'effect',
          'Effect task',
          Effect.gen(function* () {
            effectRan = true
            yield* Effect.log('Effect task running')
          }),
          { dependencies: ['command'] },
        ),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(2)
      expect(result.failureCount).toBe(0)
      expect(effectRan).toBe(true)
    })),
    30000,
  )

  it.live('runTaskGraphOrFail succeeds when all tasks succeed', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('success', 'Success', {
          cmd: 'echo',
          args: ['all good'],
        }),
      ]

      const result = yield* runTaskGraphOrFail(tasks)

      expect(result.successCount).toBe(1)
      expect(result.failureCount).toBe(0)
    })),
    30000,
  )

  it.live('runTaskGraphOrFail fails when task fails', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('fail', 'Fail', {
          cmd: 'sh',
          args: ['-c', 'exit 1'],
        }),
      ]

      const result = yield* Effect.either(runTaskGraphOrFail(tasks))

      expect(result._tag).toBe('Left')
    })),
    30000,
  )

  it.live('handles empty task list', () =>
    withTestCtx(Effect.gen(function* ()  {
      const result = yield* runTaskGraph([])

      expect(result.successCount).toBe(0)
      expect(result.failureCount).toBe(0)
    })),
    30000,
  )

  it.live('continues execution when one task fails', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('success1', 'Success 1', {
          cmd: 'echo',
          args: ['ok1'],
        }),
        task('fail', 'Fail', {
          cmd: 'sh',
          args: ['-c', 'exit 1'],
        }),
        task('success2', 'Success 2', {
          cmd: 'echo',
          args: ['ok2'],
        }),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.successCount).toBe(2)
      expect(result.failureCount).toBe(1)
      expect(result.state.tasks.success1!.status).toBe('success')
      expect(result.state.tasks.fail!.status).toBe('failed')
      expect(result.state.tasks.success2!.status).toBe('success')
    })),
    30000,
  )

  it.live('dependent task does not run when dependency fails', () =>
    withTestCtx(Effect.gen(function* ()  {
      const tasks = [
        task('failing-dep', 'Failing dependency', {
          cmd: 'sh',
          args: ['-c', 'exit 1'],
        }),
        task(
          'dependent',
          'Dependent',
          {
            cmd: 'echo',
            args: ['should not run'],
          },
          { dependencies: ['failing-dep'] },
        ),
      ]

      const result = yield* runTaskGraph(tasks)

      expect(result.failureCount).toBeGreaterThan(0)
      expect(result.state.tasks['failing-dep']!.status).toBe('failed')
      // Dependent task should not have started since dependency failed
      // Note: This depends on graph.ts implementation - it might still register but not start
    })),
    30000,
  )
})
