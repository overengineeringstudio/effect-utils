/**
 * Unit tests for task factory API.
 * Tests pure logic of task creation functions.
 */

import { describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { commandTask, effectTask, task } from './api.ts'

describe('task factory', () => {
  describe('command tasks', () => {
    it.effect('creates command task with correct structure', () =>
      Effect.gen(function* () {
        const t = task('test-cmd', 'Test Command', {
          cmd: 'echo',
          args: ['hello'],
        })

        expect(t.id).toBe('test-cmd')
        expect(t.name).toBe('Test Command')
        expect(t.dependencies).toBeUndefined()
        expect(typeof t.eventStream).toBe('function')
      }),
    )

    it.effect('creates command task with dependencies', () =>
      Effect.gen(function* () {
        const t = task(
          'dependent',
          'Dependent Task',
          {
            cmd: 'echo',
            args: ['world'],
          },
          { dependencies: ['task1', 'task2'] },
        )

        expect(t.id).toBe('dependent')
        expect(t.dependencies).toEqual(['task1', 'task2'])
      }),
    )

    it.effect('creates command task with cwd and env', () =>
      Effect.gen(function* () {
        const t = commandTask('custom-cmd', 'Custom Command', 'npm', ['install'], {
          cwd: '/tmp/test',
          env: { NODE_ENV: 'test' },
        })

        expect(t.id).toBe('custom-cmd')
        expect(t.name).toBe('Custom Command')
      }),
    )
  })

  describe('effect tasks', () => {
    it.effect('creates effect task with correct structure', () =>
      Effect.gen(function* () {
        const testEffect = Effect.succeed('result')
        const t = task('test-effect', 'Test Effect', testEffect)

        expect(t.id).toBe('test-effect')
        expect(t.name).toBe('Test Effect')
        expect(t.dependencies).toBeUndefined()
        expect(typeof t.eventStream).toBe('function')
        expect(t.effect).toBe(testEffect)
      }),
    )

    it.effect('creates effect task with dependencies', () =>
      Effect.gen(function* () {
        const testEffect = Effect.succeed('result')
        const t = task('dependent-effect', 'Dependent Effect', testEffect, {
          dependencies: ['prereq'],
        })

        expect(t.id).toBe('dependent-effect')
        expect(t.dependencies).toEqual(['prereq'])
        expect(t.effect).toBe(testEffect)
      }),
    )

    it.effect('effect task eventStream returns empty stream', () =>
      Effect.gen(function* () {
        const testEffect = Effect.succeed('result')
        const t = task('empty-stream', 'Empty Stream', testEffect)

        const stream = t.eventStream('empty-stream')
        const events = yield* Stream.runCollect(stream)

        expect(Array.from(events)).toEqual([])
      }),
    )
  })

  describe('helper functions', () => {
    it.effect('commandTask creates valid task', () =>
      Effect.gen(function* () {
        const t = commandTask('cmd-helper', 'Command Helper', 'ls', ['-la'], {
          cwd: '/tmp',
          dependencies: ['setup'],
        })

        expect(t.id).toBe('cmd-helper')
        expect(t.name).toBe('Command Helper')
        expect(t.dependencies).toEqual(['setup'])
      }),
    )

    it.effect('effectTask creates valid task', () =>
      Effect.gen(function* () {
        const testEffect = Effect.gen(function* () {
          yield* Effect.log('test')
          return 'done'
        })

        const t = effectTask('effect-helper', 'Effect Helper', testEffect, {
          dependencies: ['before'],
        })

        expect(t.id).toBe('effect-helper')
        expect(t.name).toBe('Effect Helper')
        expect(t.dependencies).toEqual(['before'])
        expect(t.effect).toBe(testEffect)
      }),
    )
  })

  describe('type discrimination', () => {
    it.effect('correctly identifies command spec vs effect', () =>
      Effect.gen(function* () {
        // Command task should have eventStream but effect is created internally
        const cmdTask = task('cmd', 'Command', {
          cmd: 'echo',
          args: ['test'],
        })

        expect(typeof cmdTask.eventStream).toBe('function')

        // Effect task should have both eventStream and effect
        const effTask = task('eff', 'Effect', Effect.succeed('value'))

        expect(typeof effTask.eventStream).toBe('function')
        expect(effTask.effect).toBeDefined()
      }),
    )
  })

  describe('edge cases', () => {
    it.effect('handles empty args array', () =>
      Effect.gen(function* () {
        const t = task('no-args', 'No Args', {
          cmd: 'pwd',
          args: [],
        })

        expect(t.id).toBe('no-args')
      }),
    )

    it.effect('handles empty dependencies array', () =>
      Effect.gen(function* () {
        const t = task('empty-deps', 'Empty Deps', Effect.succeed('ok'), { dependencies: [] })

        expect(t.dependencies).toEqual([])
      }),
    )

    it.effect('preserves task id type', () =>
      Effect.gen(function* () {
        type TaskId = 'build' | 'test' | 'deploy'

        const t = task('build' as TaskId, 'Build', Effect.succeed('built'))

        // TypeScript should enforce this at compile time
        expect(t.id).toBe('build')
      }),
    )
  })
})
