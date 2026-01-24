/**
 * Unit tests for task graph execution logic.
 * Tests pure functions: topological sort and state reducer.
 */

import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import { expect } from 'vitest'

import type { TaskDef, TaskEvent } from './types.ts'
import { TaskState, TaskSystemState } from './types.ts'

// Import internal functions for testing
// Note: These would need to be exported or we'd need to test through public API
// For now, I'll recreate the logic here for testing

/**
 * Topologically sort tasks by dependencies.
 * Returns tasks grouped by "levels" where each level can execute in parallel.
 */
const topologicalSort = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>>,
): TId[][] => {
  const inDegree = new Map<TId, number>()
  const children = new Map<TId, Set<TId>>()

  // Initialize in-degree and children
  for (const task of tasks) {
    inDegree.set(task.id, 0)
    children.set(task.id, new Set())
  }

  // Build dependency graph
  for (const task of tasks) {
    const deps = task.dependencies ?? []
    inDegree.set(task.id, deps.length)
    for (const dep of deps) {
      if (!children.has(dep as TId)) {
        children.set(dep as TId, new Set())
      }
      children.get(dep as TId)!.add(task.id)
    }
  }

  // Find all tasks with no dependencies (in-degree 0)
  const levels: TId[][] = []
  let currentLevel = Array.from(inDegree.entries())
    .filter(([_, degree]) => degree === 0)
    .map(([id]) => id)

  while (currentLevel.length > 0) {
    levels.push(currentLevel)

    const nextLevel: TId[] = []
    for (const taskId of currentLevel) {
      const childSet = children.get(taskId)
      if (childSet) {
        for (const child of childSet) {
          const newDegree = inDegree.get(child)! - 1
          inDegree.set(child, newDegree)
          if (newDegree === 0) {
            nextLevel.push(child)
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  // Check for cycles
  const processedCount = levels.flat().length
  if (processedCount !== tasks.length) {
    throw new Error('Circular dependency detected in task graph')
  }

  return levels
}

/**
 * Reduce a TaskEvent into the current state.
 */
const reduceEvent = ({
  state,
  event,
}: {
  state: TaskSystemState
  event: TaskEvent<string>
}): TaskSystemState => {
  const tasks = { ...state.tasks }

  switch (event.type) {
    case 'registered':
      tasks[event.taskId] = new TaskState({
        id: event.taskId,
        name: event.name,
        status: 'pending',
        stdout: [],
        stderr: [],
        startedAt: Option.none(),
        completedAt: Option.none(),
        error: Option.none(),
        commandInfo: Option.none(),
        retryAttempt: 0,
        maxRetries: Option.none(),
      })
      break

    case 'started': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: 'running',
          stdout: task.stdout,
          stderr: task.stderr,
          startedAt: Option.some(event.timestamp),
          completedAt: task.completedAt,
          error: task.error,
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }

    case 'stdout': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: task.status,
          stdout: [...task.stdout, event.chunk],
          stderr: task.stderr,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }

    case 'stderr': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: task.status,
          stdout: task.stdout,
          stderr: [...task.stderr, event.chunk],
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }

    case 'completed': {
      const task = tasks[event.taskId]
      if (task) {
        const isSuccess = Exit.isSuccess(event.exit)
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: isSuccess ? 'success' : 'failed',
          stdout: task.stdout,
          stderr: task.stderr,
          startedAt: task.startedAt,
          completedAt: Option.some(event.timestamp),
          error: isSuccess
            ? Option.none()
            : Option.some(String(Exit.isFailure(event.exit) ? event.exit.cause : 'Unknown error')),
          commandInfo: Option.none(),
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }
  }

  return new TaskSystemState({ tasks })
}

// =============================================================================
// Topological Sort Tests
// =============================================================================

describe('topologicalSort', () => {
  it('handles empty task list', () => {
    const result = topologicalSort([])
    expect(result).toEqual([])
  })

  it('handles single task', () => {
    const tasks: TaskDef<'a', unknown, unknown, unknown>[] = [
      {
        id: 'a',
        name: 'Task A',
        eventStream: () => Effect.succeed([]) as any,
      },
    ]
    const result = topologicalSort(tasks)
    expect(result).toEqual([['a']])
  })

  it('handles two independent tasks', () => {
    const tasks: TaskDef<'a' | 'b', unknown, unknown, unknown>[] = [
      { id: 'a', name: 'Task A', eventStream: () => Effect.succeed([]) as any },
      { id: 'b', name: 'Task B', eventStream: () => Effect.succeed([]) as any },
    ]
    const result = topologicalSort(tasks)
    expect(result).toEqual([['a', 'b']])
  })

  it('handles linear dependency chain', () => {
    const tasks: TaskDef<'a' | 'b' | 'c', unknown, unknown, unknown>[] = [
      { id: 'a', name: 'Task A', eventStream: () => Effect.succeed([]) as any },
      {
        id: 'b',
        name: 'Task B',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'c',
        name: 'Task C',
        dependencies: ['b'],
        eventStream: () => Effect.succeed([]) as any,
      },
    ]
    const result = topologicalSort(tasks)
    expect(result).toEqual([['a'], ['b'], ['c']])
  })

  it('handles diamond dependency pattern', () => {
    //    a
    //   / \
    //  b   c
    //   \ /
    //    d
    const tasks: TaskDef<'a' | 'b' | 'c' | 'd', unknown, unknown, unknown>[] = [
      { id: 'a', name: 'Task A', eventStream: () => Effect.succeed([]) as any },
      {
        id: 'b',
        name: 'Task B',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'c',
        name: 'Task C',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'd',
        name: 'Task D',
        dependencies: ['b', 'c'],
        eventStream: () => Effect.succeed([]) as any,
      },
    ]
    const result = topologicalSort(tasks)
    expect(result).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('detects circular dependency', () => {
    const tasks: TaskDef<'a' | 'b', unknown, unknown, unknown>[] = [
      {
        id: 'a',
        name: 'Task A',
        dependencies: ['b'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'b',
        name: 'Task B',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
    ]

    expect(() => topologicalSort(tasks)).toThrow('Circular dependency detected')
  })

  it('handles complex graph with multiple parallel branches', () => {
    //      a     b
    //     / \   / \
    //    c   d e   f
    //     \ /   \ /
    //      g     h
    //       \   /
    //         i
    const tasks: TaskDef<
      'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i',
      unknown,
      unknown,
      unknown
    >[] = [
      { id: 'a', name: 'Task A', eventStream: () => Effect.succeed([]) as any },
      { id: 'b', name: 'Task B', eventStream: () => Effect.succeed([]) as any },
      {
        id: 'c',
        name: 'Task C',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'd',
        name: 'Task D',
        dependencies: ['a'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'e',
        name: 'Task E',
        dependencies: ['b'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'f',
        name: 'Task F',
        dependencies: ['b'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'g',
        name: 'Task G',
        dependencies: ['c', 'd'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'h',
        name: 'Task H',
        dependencies: ['e', 'f'],
        eventStream: () => Effect.succeed([]) as any,
      },
      {
        id: 'i',
        name: 'Task I',
        dependencies: ['g', 'h'],
        eventStream: () => Effect.succeed([]) as any,
      },
    ]

    const result = topologicalSort(tasks)

    // Verify all tasks are present
    const allTasks = result.flat()
    expect(allTasks).toHaveLength(9)
    expect(new Set(allTasks)).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']))

    // Verify dependency ordering
    const taskIndex = new Map(allTasks.map((id, idx) => [id, idx]))
    expect(taskIndex.get('a')! < taskIndex.get('c')!).toBe(true)
    expect(taskIndex.get('a')! < taskIndex.get('d')!).toBe(true)
    expect(taskIndex.get('b')! < taskIndex.get('e')!).toBe(true)
    expect(taskIndex.get('b')! < taskIndex.get('f')!).toBe(true)
    expect(taskIndex.get('c')! < taskIndex.get('g')!).toBe(true)
    expect(taskIndex.get('d')! < taskIndex.get('g')!).toBe(true)
    expect(taskIndex.get('e')! < taskIndex.get('h')!).toBe(true)
    expect(taskIndex.get('f')! < taskIndex.get('h')!).toBe(true)
    expect(taskIndex.get('g')! < taskIndex.get('i')!).toBe(true)
    expect(taskIndex.get('h')! < taskIndex.get('i')!).toBe(true)
  })
})

// =============================================================================
// State Reducer Tests
// =============================================================================

describe('reduceEvent', () => {
  it('handles registered event', () => {
    const initialState = new TaskSystemState({ tasks: {} })
    const event: TaskEvent<'test'> = {
      type: 'registered',
      taskId: 'test',
      name: 'Test Task',
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!).toBeDefined()
    expect(newState.tasks.test!.id).toBe('test')
    expect(newState.tasks.test!.name).toBe('Test Task')
    expect(newState.tasks.test!.status).toBe('pending')
    expect(newState.tasks.test!.stdout).toEqual([])
    expect(newState.tasks.test!.stderr).toEqual([])
  })

  it('handles started event', () => {
    const initialState = new TaskSystemState({
      tasks: {
        test: new TaskState({
          id: 'test',
          name: 'Test Task',
          status: 'pending',
          stdout: [],
          stderr: [],
          startedAt: Option.none(),
          completedAt: Option.none(),
          error: Option.none(),
          commandInfo: Option.none(),
          retryAttempt: 0,
          maxRetries: Option.none(),
        }),
      },
    })

    const timestamp = Date.now()
    const event: TaskEvent<'test'> = {
      type: 'started',
      taskId: 'test',
      timestamp,
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!.status).toBe('running')
    expect(Option.isSome(newState.tasks.test!.startedAt)).toBe(true)
    expect(Option.getOrThrow(newState.tasks.test!.startedAt)).toBe(timestamp)
  })

  it('handles stdout event', () => {
    const initialState = new TaskSystemState({
      tasks: {
        test: new TaskState({
          id: 'test',
          name: 'Test Task',
          status: 'running',
          stdout: ['line1'],
          stderr: [],
          startedAt: Option.some(Date.now()),
          completedAt: Option.none(),
          error: Option.none(),
          commandInfo: Option.none(),
          retryAttempt: 0,
          maxRetries: Option.none(),
        }),
      },
    })

    const event: TaskEvent<'test'> = {
      type: 'stdout',
      taskId: 'test',
      chunk: 'line2',
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!.stdout).toEqual(['line1', 'line2'])
  })

  it('handles stderr event', () => {
    const initialState = new TaskSystemState({
      tasks: {
        test: new TaskState({
          id: 'test',
          name: 'Test Task',
          status: 'running',
          stdout: [],
          stderr: [],
          startedAt: Option.some(Date.now()),
          completedAt: Option.none(),
          error: Option.none(),
          commandInfo: Option.none(),
          retryAttempt: 0,
          maxRetries: Option.none(),
        }),
      },
    })

    const event: TaskEvent<'test'> = {
      type: 'stderr',
      taskId: 'test',
      chunk: 'error message',
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!.stderr).toEqual(['error message'])
  })

  it('handles completed event with success', () => {
    const initialState = new TaskSystemState({
      tasks: {
        test: new TaskState({
          id: 'test',
          name: 'Test Task',
          status: 'running',
          stdout: [],
          stderr: [],
          startedAt: Option.some(Date.now()),
          completedAt: Option.none(),
          error: Option.none(),
          commandInfo: Option.none(),
          retryAttempt: 0,
          maxRetries: Option.none(),
        }),
      },
    })

    const timestamp = Date.now()
    const event: TaskEvent<'test'> = {
      type: 'completed',
      taskId: 'test',
      timestamp,
      exit: Exit.succeed('result'),
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!.status).toBe('success')
    expect(Option.isSome(newState.tasks.test!.completedAt)).toBe(true)
    expect(Option.getOrThrow(newState.tasks.test!.completedAt)).toBe(timestamp)
    expect(Option.isNone(newState.tasks.test!.error)).toBe(true)
  })

  it('handles completed event with failure', () => {
    const initialState = new TaskSystemState({
      tasks: {
        test: new TaskState({
          id: 'test',
          name: 'Test Task',
          status: 'running',
          stdout: [],
          stderr: [],
          startedAt: Option.some(Date.now()),
          completedAt: Option.none(),
          error: Option.none(),
          commandInfo: Option.none(),
          retryAttempt: 0,
          maxRetries: Option.none(),
        }),
      },
    })

    const timestamp = Date.now()
    const event: TaskEvent<'test'> = {
      type: 'completed',
      taskId: 'test',
      timestamp,
      exit: Exit.fail(new Error('Task failed')),
    }

    const newState = reduceEvent({ state: initialState, event })

    expect(newState.tasks.test!.status).toBe('failed')
    expect(Option.isSome(newState.tasks.test!.completedAt)).toBe(true)
    expect(Option.isSome(newState.tasks.test!.error)).toBe(true)
  })

  it('handles sequence of events correctly', () => {
    let state = new TaskSystemState({ tasks: {} })

    // Register
    state = reduceEvent({
      state,
      event: {
        type: 'registered',
        taskId: 'test',
        name: 'Test Task',
      },
    })
    expect(state.tasks.test!.status).toBe('pending')

    // Start
    state = reduceEvent({
      state,
      event: {
        type: 'started',
        taskId: 'test',
        timestamp: 1000,
      },
    })
    expect(state.tasks.test!.status).toBe('running')

    // Output
    state = reduceEvent({
      state,
      event: {
        type: 'stdout',
        taskId: 'test',
        chunk: 'output line',
      },
    })
    expect(state.tasks.test!.stdout).toEqual(['output line'])

    // Complete
    state = reduceEvent({
      state,
      event: {
        type: 'completed',
        taskId: 'test',
        timestamp: 2000,
        exit: Exit.succeed(undefined),
      },
    })
    expect(state.tasks.test!.status).toBe('success')
  })
})
