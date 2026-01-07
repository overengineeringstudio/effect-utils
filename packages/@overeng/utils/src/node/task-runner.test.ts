import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Chunk, Effect, Layer, Option, Stream } from 'effect'
import { expect } from 'vitest'

import { printFinalSummary, TaskRunner, TasksFailedError } from './task-runner.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

const TestLayer = Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live, TaskRunner.live)

describe('TaskRunner', () => {
  it.effect('registers tasks with pending status', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'task1', name: 'Task 1' })
      yield* runner.register({ id: 'task2', name: 'Task 2' })

      const state = yield* runner.get
      expect(state.tasks).toHaveLength(2)
      expect(state.tasks[0]?.id).toBe('task1')
      expect(state.tasks[0]?.name).toBe('Task 1')
      expect(state.tasks[0]?.status).toBe('pending')
      expect(state.tasks[1]?.id).toBe('task2')
      expect(state.tasks[1]?.status).toBe('pending')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('runs successful command and captures stdout', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'echo', name: 'Echo test' })
      yield* runner.runTask({ id: 'echo', command: 'printf', args: ['hello'] })

      const state = yield* runner.get
      expect(state.tasks[0]?.status).toBe('success')
      expect(state.tasks[0]?.stdout).toContain('hello')
      expect(Option.isSome(state.tasks[0]?.duration ?? Option.none())).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('runs failing command and captures status', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'fail', name: 'Failing test' })
      yield* runner.runTask({ id: 'fail', command: 'bun', args: ['-e', 'process.exit(1)'] })

      const state = yield* runner.get
      expect(state.tasks[0]?.status).toBe('failed')
      expect(Option.isSome(state.tasks[0]?.error ?? Option.none())).toBe(true)
      expect(Option.getOrElse(state.tasks[0]?.error ?? Option.none(), () => '')).toContain(
        'Exit code: 1',
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('runs multiple tasks concurrently with runAll', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 't1', name: 'Task 1' })
      yield* runner.register({ id: 't2', name: 'Task 2' })

      yield* runner.runAll([
        runner.runTask({ id: 't1', command: 'printf', args: ['one'] }),
        runner.runTask({ id: 't2', command: 'printf', args: ['two'] }),
      ])

      const state = yield* runner.get
      expect(state.tasks[0]?.status).toBe('success')
      expect(state.tasks[1]?.status).toBe('success')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('checkForFailures succeeds when all tasks pass', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'ok', name: 'OK task' })
      yield* runner.runTask({ id: 'ok', command: 'printf', args: ['ok'] })

      yield* runner.checkForFailures()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('checkForFailures returns TasksFailedError when tasks fail', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'ok', name: 'OK task' })
      yield* runner.register({ id: 'fail', name: 'Failing task' })

      yield* runner.runAll([
        runner.runTask({ id: 'ok', command: 'printf', args: ['ok'] }),
        runner.runTask({ id: 'fail', command: 'bun', args: ['-e', 'process.exit(1)'] }),
      ])

      const result = yield* runner.checkForFailures().pipe(Effect.either)
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(TasksFailedError)
        expect(result.left.failedTaskIds).toContain('fail')
        expect(result.left.message).toBe('1 task(s) failed')
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('render produces status output', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 't1', name: 'Pending task' })
      yield* runner.register({ id: 't2', name: 'Success task' })
      yield* runner.runTask({ id: 't2', command: 'printf', args: ['done'] })

      const output = yield* runner.render()
      expect(output).toContain('○ Pending task')
      expect(output).toContain('✓ Success task')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('changes stream is accessible', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      /** Just verify that we can access the changes stream and it emits initial state */
      const firstState = yield* runner.changes.pipe(Stream.take(1), Stream.runCollect)
      const states = Chunk.toReadonlyArray(firstState)

      expect(states.length).toBe(1)
      expect(states[0]?.tasks).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('captures stderr from commands', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'stderr', name: 'Stderr test' })
      yield* runner.runTask({
        id: 'stderr',
        command: 'bun',
        args: ['-e', "console.error('error output')"],
      })

      const state = yield* runner.get
      expect(state.tasks[0]?.stderr.join('')).toContain('error output')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('TaskRunner.task convenience method works', () =>
    Effect.gen(function* () {
      yield* TaskRunner.task({
        id: 'convenience',
        name: 'Convenience test',
        command: 'printf',
        args: ['hello'],
      })

      const runner = yield* TaskRunner
      const state = yield* runner.get
      expect(state.tasks[0]?.id).toBe('convenience')
      expect(state.tasks[0]?.status).toBe('success')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('printFinalSummary succeeds when all tasks pass', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'ok', name: 'OK task' })
      yield* runner.runTask({ id: 'ok', command: 'printf', args: ['ok'] })

      yield* printFinalSummary
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('printFinalSummary fails when tasks fail', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'fail', name: 'Failing task' })
      yield* runner.runTask({ id: 'fail', command: 'bun', args: ['-e', 'process.exit(1)'] })

      const result = yield* printFinalSummary.pipe(Effect.either)
      expect(result._tag).toBe('Left')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('runTask honors cwd option', () =>
    Effect.gen(function* () {
      const runner = yield* TaskRunner

      yield* runner.register({ id: 'cwd', name: 'CWD test' })
      yield* runner.runTask({
        id: 'cwd',
        command: 'pwd',
        args: [],
        cwd: '/tmp',
      })

      const state = yield* runner.get
      expect(state.tasks[0]?.status).toBe('success')
      expect(state.tasks[0]?.stdout.join('')).toContain('/tmp')
    }).pipe(Effect.provide(TestLayer)),
  )
})
