/**
 * Unit tests for PiTuiInlineRenderer.
 *
 * Tests rendering behavior using mocked pi-tui components to verify:
 * - Spinner animation (frames change over time)
 * - Duration updates (times increase)
 * - Task state changes are reflected
 */

import * as assert from 'node:assert'

import { Atom, Registry } from '@effect-atom/atom'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { TaskState, TaskSystemState } from '../types.ts'
import { SPINNER_FRAMES } from '../ui/pi-tui/StatusRenderer.ts'
import { TaskSystemComponent } from '../ui/pi-tui/TaskSystemComponent.ts'

/** Create a test task state */
const makeTestTask = (overrides: Partial<TaskState> = {}): TaskState =>
  new TaskState({
    id: 'test-task',
    name: 'Test Task',
    status: 'running',
    stdout: [],
    stderr: [],
    startedAt: Option.some(Date.now() - 1000), // Started 1 second ago
    completedAt: Option.none(),
    error: Option.none(),
    commandInfo: Option.none(),
    retryAttempt: 0,
    maxRetries: Option.none(),
    ...overrides,
  })

/** Create test system state with tasks */
const makeTestState = (tasks: TaskState[]): TaskSystemState =>
  new TaskSystemState({
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  })

describe('TaskSystemComponent', () => {
  describe('spinner animation', () => {
    it('increments spinner frame on each render when tasks are active', () => {
      const registry = Registry.make()
      const runningTask = makeTestTask({ status: 'running' })
      const stateAtom = Atom.make(makeTestState([runningTask]))

      const component = new TaskSystemComponent({ stateAtom, registry })

      // First render
      const output1 = component.render(80)
      // Second render
      const output2 = component.render(80)
      // Third render
      const output3 = component.render(80)

      // Outputs should be different because spinner frame increments
      // (Different spinner character should be shown)
      assert.notStrictEqual(output1[1], output2[1], 'Spinner should animate between renders')
      assert.notStrictEqual(output2[1], output3[1], 'Spinner should continue animating')

      registry.dispose()
    })

    it('uses valid spinner frames', () => {
      const registry = Registry.make()
      const runningTask = makeTestTask({ status: 'running' })
      const stateAtom = Atom.make(makeTestState([runningTask]))

      const component = new TaskSystemComponent({ stateAtom, registry })

      // Render multiple times and check all spinner chars are valid
      for (let i = 0; i < SPINNER_FRAMES.length + 2; i++) {
        const output = component.render(80)
        const taskLine = output[1] // First task line (after padding)

        // Check that at least one valid spinner frame appears in the output
        const hasValidSpinner = SPINNER_FRAMES.some((frame) => taskLine?.includes(frame))
        const hasCheckmark = taskLine?.includes('✓')
        const hasX = taskLine?.includes('✗')

        assert.ok(
          hasValidSpinner || hasCheckmark || hasX,
          `Task line should contain a valid status icon: ${taskLine}`,
        )
      }

      registry.dispose()
    })

    it('does not increment spinner when no active tasks', () => {
      const registry = Registry.make()
      const completedTask = makeTestTask({ status: 'success' })
      const stateAtom = Atom.make(makeTestState([completedTask]))

      const component = new TaskSystemComponent({ stateAtom, registry })

      // Multiple renders
      const output1 = component.render(80)
      const output2 = component.render(80)
      const output3 = component.render(80)

      // All outputs should be the same (no spinner animation for completed tasks)
      assert.strictEqual(output1[1], output2[1], 'Completed task should not animate')
      assert.strictEqual(output2[1], output3[1], 'Completed task should remain static')

      registry.dispose()
    })
  })

  describe('duration formatting', () => {
    it('shows increasing duration for running tasks', () =>
      Effect.gen(function* () {
        const registry = Registry.make()
        const startTime = Date.now()
        const runningTask = makeTestTask({
          status: 'running',
          startedAt: Option.some(startTime),
        })
        const stateAtom = Atom.make(makeTestState([runningTask]))

        const component = new TaskSystemComponent({ stateAtom, registry })

        // First render
        const output1 = component.render(80)

        // Wait a bit
        yield* Effect.sleep('100 millis')

        // Second render - duration should be higher
        const output2 = component.render(80)

        // Extract duration from outputs (format: "Task Name (X.Xs)")
        const extractDuration = (line: string): number | undefined => {
          const match = line.match(/\((\d+\.?\d*)s\)/)
          return match ? parseFloat(match[1]!) : undefined
        }

        const duration1 = extractDuration(output1[1] || '')
        const duration2 = extractDuration(output2[1] || '')

        assert.ok(duration1 !== undefined, `Should have duration in first output: ${output1[1]}`)
        assert.ok(duration2 !== undefined, `Should have duration in second output: ${output2[1]}`)
        assert.ok(
          duration2! >= duration1!,
          `Duration should increase: ${duration1}s -> ${duration2}s`,
        )

        registry.dispose()
      }))
  })

  describe('state updates', () => {
    it('reflects task state changes', () => {
      const registry = Registry.make()
      const task = makeTestTask({ status: 'running' })
      const stateAtom = Atom.make(makeTestState([task]))

      const component = new TaskSystemComponent({ stateAtom, registry })

      // Render running state
      const runningOutput = component.render(80)
      assert.ok(
        SPINNER_FRAMES.some((frame) => runningOutput[1]?.includes(frame)),
        'Running task should show spinner',
      )

      // Update state to success
      registry.set(
        stateAtom,
        makeTestState([
          makeTestTask({
            status: 'success',
            completedAt: Option.some(Date.now()),
          }),
        ]),
      )

      // Render success state
      const successOutput = component.render(80)
      assert.ok(successOutput[1]?.includes('✓'), 'Completed task should show checkmark')

      registry.dispose()
    })
  })

  describe('output structure', () => {
    it('includes padding lines', () => {
      const registry = Registry.make()
      const task = makeTestTask()
      const stateAtom = Atom.make(makeTestState([task]))

      const component = new TaskSystemComponent({ stateAtom, registry })
      const output = component.render(80)

      // Should have: empty line, task line, empty line
      assert.strictEqual(output[0], '', 'First line should be empty (top padding)')
      assert.strictEqual(
        output[output.length - 1],
        '',
        'Last line should be empty (bottom padding)',
      )
      assert.ok(output.length >= 3, 'Should have at least padding + task + padding')

      registry.dispose()
    })

    it('renders multiple tasks', () => {
      const registry = Registry.make()
      const tasks = [
        makeTestTask({ id: 'task-1', name: 'Task 1', status: 'success' }),
        makeTestTask({ id: 'task-2', name: 'Task 2', status: 'running' }),
        makeTestTask({ id: 'task-3', name: 'Task 3', status: 'pending' }),
      ]
      const stateAtom = Atom.make(makeTestState(tasks))

      const component = new TaskSystemComponent({ stateAtom, registry })
      const output = component.render(80)

      // Should have: padding + 3 tasks + padding = 5 lines
      assert.strictEqual(output.length, 5, 'Should have 5 lines for 3 tasks with padding')

      registry.dispose()
    })
  })
})
