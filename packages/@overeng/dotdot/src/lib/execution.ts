/**
 * Execution modes for running operations across multiple repos
 */

import { Effect, Schema } from 'effect'

import { type CycleError, type Graph, toLayers, topologicalSort } from './graph.ts'

/** Execution mode for repo operations */
export type ExecutionMode = 'parallel' | 'sequential' | 'topo' | 'topo-parallel'

/** Execution mode schema for CLI parsing */
export const ExecutionModeSchema = Schema.Literal('parallel', 'sequential', 'topo', 'topo-parallel')

/** Options for execution */
export type ExecutionOptions = {
  mode: ExecutionMode
  maxParallel?: number | undefined
}

/** Options for topological execution */
export type TopoExecutionOptions<T> = ExecutionOptions & {
  /** Dependency graph for topo modes */
  graph?: Graph<T> | undefined
}

/**
 * Execute effects for multiple items with the specified mode
 * @param items - Items to process (must be [id, data] tuples for topo modes)
 * @param fn - Function to run for each item
 * @param options - Execution options (including optional graph for topo modes)
 */
export const executeForAll = <T, A, E, R>(
  items: T[],
  fn: (item: T) => Effect.Effect<A, E, R>,
  options: ExecutionOptions,
): Effect.Effect<A[], E, R> => {
  const concurrency = options.mode === 'parallel' ? (options.maxParallel ?? 'unbounded') : 1

  return Effect.all(items.map(fn), { concurrency })
}

/**
 * Execute effects in topological order
 * Items must be [id, data] tuples where id matches graph node IDs
 * @param items - Items to process as [id, data] tuples
 * @param fn - Function to run for each item
 * @param graph - Dependency graph
 * @param options - Execution options
 */
export const executeTopoForAll = <K extends string, V, A, E, R>(
  items: Array<[K, V]>,
  fn: (item: [K, V]) => Effect.Effect<A, E, R>,
  graph: Graph<unknown>,
  options: ExecutionOptions,
): Effect.Effect<A[], E | CycleError, R> =>
  Effect.gen(function* () {
    const itemMap = new Map(items)

    if (options.mode === 'topo') {
      // Sequential in topological order
      const sorted = yield* topologicalSort(graph)
      const results: A[] = []

      for (const id of sorted) {
        const data = itemMap.get(id as K)
        if (data !== undefined) {
          const result = yield* fn([id as K, data])
          results.push(result)
        }
      }

      return results
    } else if (options.mode === 'topo-parallel') {
      // Parallel within layers, sequential between layers
      const layers = yield* toLayers(graph)
      const results: A[] = []
      const concurrency = options.maxParallel ?? 'unbounded'

      for (const layer of layers) {
        const layerItems = layer
          .filter((id) => itemMap.has(id as K))
          .map((id) => [id as K, itemMap.get(id as K)!] as [K, V])

        if (layerItems.length > 0) {
          const layerResults = yield* Effect.all(layerItems.map(fn), {
            concurrency,
          })
          results.push(...layerResults)
        }
      }

      return results
    }

    // Fallback to regular execution
    return yield* executeForAll(items, fn, options)
  })

/**
 * Execute effects for multiple items in parallel
 */
export const executeParallel = <T, A, E, R>(
  items: T[],
  fn: (item: T) => Effect.Effect<A, E, R>,
  maxParallel?: number | undefined,
): Effect.Effect<A[], E, R> => executeForAll(items, fn, { mode: 'parallel', maxParallel })

/**
 * Execute effects for multiple items sequentially
 */
export const executeSequential = <T, A, E, R>(
  items: T[],
  fn: (item: T) => Effect.Effect<A, E, R>,
): Effect.Effect<A[], E, R> => executeForAll(items, fn, { mode: 'sequential' })
