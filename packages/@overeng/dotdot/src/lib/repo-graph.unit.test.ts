/**
 * Tests for repo dependency graph using Effect.Graph
 */

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type ExecutionMode, executeTopoForAll } from './execution.ts'
import * as RepoGraph from './repo-graph.ts'

describe('RepoGraph', () => {
  describe('topologicalSort', () => {
    it('sorts nodes with no dependencies', async () => {
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'a', config: { url: 'url-a' } })
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'b', config: { url: 'url-b' } })
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'c', config: { url: 'url-c' } })

      const result = await Effect.runPromise(RepoGraph.topologicalSort(graph))

      expect(result).toHaveLength(3)
      expect(result).toContain('a')
      expect(result).toContain('b')
      expect(result).toContain('c')
    })

    it('sorts linear dependencies', async () => {
      // c -> b -> a (a has no deps, b depends on a, c depends on b)
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: [],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['b'],
      })

      const result = await Effect.runPromise(RepoGraph.topologicalSort(graph))

      expect(result).toEqual(['a', 'b', 'c'])
    })

    it('sorts diamond dependencies', async () => {
      // d depends on b and c, both b and c depend on a
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: [],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'd',
        config: { url: 'url-d' },
        dependencies: ['b', 'c'],
      })

      const result = await Effect.runPromise(RepoGraph.topologicalSort(graph))

      // a must come first, d must come last
      expect(result[0]).toBe('a')
      expect(result[3]).toBe('d')
      // b and c can be in either order, but both before d
      expect(result.indexOf('b')).toBeLessThan(result.indexOf('d'))
      expect(result.indexOf('c')).toBeLessThan(result.indexOf('d'))
    })

    it('detects cycles', async () => {
      // a -> b -> c -> a (cycle)
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: ['c'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['b'],
      })

      const result = await Effect.runPromise(
        RepoGraph.topologicalSort(graph).pipe(
          Effect.map(() => null),
          Effect.catchTag('CycleError', (e) => Effect.succeed(e)),
        ),
      )

      expect(result).not.toBeNull()
      expect(result?._tag).toBe('CycleError')
    })

    it('ignores dependencies not in graph', async () => {
      // b depends on 'missing' which doesn't exist
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: [],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['missing'],
      })

      const result = await Effect.runPromise(RepoGraph.topologicalSort(graph))

      // 'missing' gets auto-created as a node
      expect(result).toHaveLength(3)
      expect(result).toContain('a')
      expect(result).toContain('b')
      expect(result).toContain('missing')
    })
  })

  describe('toLayers', () => {
    it('groups independent nodes in same layer', async () => {
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'a', config: { url: 'url-a' } })
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'b', config: { url: 'url-b' } })
      graph = RepoGraph.addRepo({ repoGraph: graph, id: 'c', config: { url: 'url-c' } })

      const layers = await Effect.runPromise(RepoGraph.toLayers(graph))

      expect(layers).toHaveLength(1)
      expect(layers[0]).toHaveLength(3)
    })

    it('separates dependent nodes into layers', async () => {
      // c -> b -> a
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: [],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['b'],
      })

      const layers = await Effect.runPromise(RepoGraph.toLayers(graph))

      expect(layers).toHaveLength(3)
      expect(layers[0]).toEqual(['a'])
      expect(layers[1]).toEqual(['b'])
      expect(layers[2]).toEqual(['c'])
    })

    it('groups diamond correctly', async () => {
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: [],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'd',
        config: { url: 'url-d' },
        dependencies: ['b', 'c'],
      })

      const layers = await Effect.runPromise(RepoGraph.toLayers(graph))

      expect(layers).toHaveLength(3)
      expect(layers[0]).toEqual(['a'])
      expect(layers[1]!.sort()).toEqual(['b', 'c'])
      expect(layers[2]).toEqual(['d'])
    })

    it('detects cycles', async () => {
      let graph = RepoGraph.empty()
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'a',
        config: { url: 'url-a' },
        dependencies: ['c'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'b',
        config: { url: 'url-b' },
        dependencies: ['a'],
      })
      graph = RepoGraph.addRepo({
        repoGraph: graph,
        id: 'c',
        config: { url: 'url-c' },
        dependencies: ['b'],
      })

      const result = await Effect.runPromise(
        RepoGraph.toLayers(graph).pipe(
          Effect.map(() => null),
          Effect.catchTag('CycleError', (e) => Effect.succeed(e)),
        ),
      )

      expect(result).not.toBeNull()
      expect(result?._tag).toBe('CycleError')
    })
  })

  describe('fromMemberConfigs', () => {
    it('builds graph from member configs with deps', () => {
      const configs = [
        {
          path: '/workspace/repo-a/dotdot.json',
          dir: '/workspace/repo-a',
          repoName: 'repo-a',
          isRoot: false as const,
          config: {
            deps: {
              'shared-lib': { url: 'git@github.com:org/shared-lib.git' },
            },
          },
        },
      ]

      const graph = RepoGraph.fromMemberConfigs(configs)

      expect(RepoGraph.repoIds(graph).sort()).toEqual(['repo-a', 'shared-lib'])
      // repo-a depends on shared-lib
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'repo-a' })).toContain('shared-lib')
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'shared-lib' })).toEqual([])
    })

    it('builds graph with multiple member configs', () => {
      const configs = [
        {
          path: '/workspace/repo-a/dotdot.json',
          dir: '/workspace/repo-a',
          repoName: 'repo-a',
          isRoot: false as const,
          config: {
            deps: {
              'shared-lib': { url: 'git@github.com:org/shared-lib.git' },
            },
          },
        },
        {
          path: '/workspace/repo-b/dotdot.json',
          dir: '/workspace/repo-b',
          repoName: 'repo-b',
          isRoot: false as const,
          config: {
            deps: {
              'shared-lib': { url: 'git@github.com:org/shared-lib.git' },
            },
          },
        },
      ]

      const graph = RepoGraph.fromMemberConfigs(configs)

      expect(RepoGraph.repoIds(graph).sort()).toEqual(['repo-a', 'repo-b', 'shared-lib'])
      // Both repos depend on shared-lib
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'repo-a' })).toContain('shared-lib')
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'repo-b' })).toContain('shared-lib')
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'shared-lib' })).toEqual([])
    })

    it('handles complex dependency chains', () => {
      const configs = [
        {
          path: '/workspace/app/dotdot.json',
          dir: '/workspace/app',
          repoName: 'app',
          isRoot: false as const,
          config: {
            deps: {
              core: { url: 'git@github.com:org/core.git' },
              utils: { url: 'git@github.com:org/utils.git' },
            },
          },
        },
        {
          path: '/workspace/core/dotdot.json',
          dir: '/workspace/core',
          repoName: 'core',
          isRoot: false as const,
          config: {
            deps: {
              utils: { url: 'git@github.com:org/utils.git' },
            },
          },
        },
      ]

      const graph = RepoGraph.fromMemberConfigs(configs)

      expect(RepoGraph.repoIds(graph).sort()).toEqual(['app', 'core', 'utils'])
      // app depends on core and utils
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'app' }).sort()).toEqual([
        'core',
        'utils',
      ])
      // core depends on utils
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'core' })).toEqual(['utils'])
      // utils has no dependencies
      expect(RepoGraph.getDependencies({ repoGraph: graph, id: 'utils' })).toEqual([])
    })
  })
})

describe('executeTopoForAll', () => {
  it('executes in topological order (topo mode)', async () => {
    const order: string[] = []

    // c -> b -> a
    let graph = RepoGraph.empty()
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'a',
      config: { url: 'url-a' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'b',
      config: { url: 'url-b' },
      dependencies: ['a'],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'c',
      config: { url: 'url-c' },
      dependencies: ['b'],
    })

    const items: Array<[string, string]> = [
      ['c', 'data-c'],
      ['a', 'data-a'],
      ['b', 'data-b'],
    ]

    await Effect.runPromise(
      executeTopoForAll({
        items,
        fn: ([id]) =>
          Effect.sync(() => {
            order.push(id)
            return id
          }),
        graph,
        options: { mode: 'topo' as ExecutionMode },
      }),
    )

    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('executes layers in parallel (topo-parallel mode)', async () => {
    const startTimes: Record<string, number> = {}
    const endTimes: Record<string, number> = {}

    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    let graph = RepoGraph.empty()
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'a',
      config: { url: 'url-a' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'b',
      config: { url: 'url-b' },
      dependencies: ['a'],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'c',
      config: { url: 'url-c' },
      dependencies: ['a'],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'd',
      config: { url: 'url-d' },
      dependencies: ['b', 'c'],
    })

    const items: Array<[string, string]> = [
      ['d', 'data-d'],
      ['b', 'data-b'],
      ['a', 'data-a'],
      ['c', 'data-c'],
    ]

    await Effect.runPromise(
      executeTopoForAll({
        items,
        fn: Effect.fnUntraced(function* ([id]) {
          startTimes[id] = Date.now()
          yield* Effect.sleep(50) // Simulate work
          endTimes[id] = Date.now()
          return id
        }),
        graph,
        options: { mode: 'topo-parallel' as ExecutionMode },
      }),
    )

    // a should finish before b and c start
    expect(endTimes['a']).toBeLessThanOrEqual(startTimes['b']!)
    expect(endTimes['a']).toBeLessThanOrEqual(startTimes['c']!)

    // b and c should run in parallel (their start times should be close)
    expect(Math.abs(startTimes['b']! - startTimes['c']!)).toBeLessThan(30)

    // d should start after both b and c finish
    expect(startTimes['d']).toBeGreaterThanOrEqual(endTimes['b']!)
    expect(startTimes['d']).toBeGreaterThanOrEqual(endTimes['c']!)
  })

  it('handles items not in graph', async () => {
    const order: string[] = []

    let graph = RepoGraph.empty()
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'a',
      config: { url: 'url-a' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'b',
      config: { url: 'url-b' },
      dependencies: ['a'],
    })

    // 'c' is in items but not in graph - should still work
    const items: Array<[string, string]> = [
      ['a', 'data-a'],
      ['b', 'data-b'],
      ['c', 'data-c'], // Not in graph
    ]

    await Effect.runPromise(
      executeTopoForAll({
        items,
        fn: ([id]) =>
          Effect.sync(() => {
            order.push(id)
            return id
          }),
        graph,
        options: { mode: 'topo' as ExecutionMode },
      }),
    )

    // a and b should be in order, c is not in graph so won't be processed
    expect(order).toEqual(['a', 'b'])
  })

  it('returns CycleError for circular dependencies', async () => {
    let graph = RepoGraph.empty()
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'a',
      config: { url: 'url-a' },
      dependencies: ['c'],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'b',
      config: { url: 'url-b' },
      dependencies: ['a'],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'c',
      config: { url: 'url-c' },
      dependencies: ['b'],
    })

    const items: Array<[string, string]> = [
      ['a', 'data-a'],
      ['b', 'data-b'],
      ['c', 'data-c'],
    ]

    const result = await Effect.runPromise(
      executeTopoForAll({
        items,
        fn: ([id]) => Effect.succeed(id),
        graph,
        options: { mode: 'topo' as ExecutionMode },
      }).pipe(
        Effect.map(() => null),
        Effect.catchTag('CycleError', (e) => Effect.succeed(e)),
      ),
    )

    expect(result).not.toBeNull()
    expect(result?._tag).toBe('CycleError')
  })

  it('respects maxParallel in topo-parallel mode', async () => {
    const concurrent: number[] = []
    let currentConcurrent = 0

    // All independent nodes
    let graph = RepoGraph.empty()
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'a',
      config: { url: 'url-a' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'b',
      config: { url: 'url-b' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'c',
      config: { url: 'url-c' },
      dependencies: [],
    })
    graph = RepoGraph.addRepo({
      repoGraph: graph,
      id: 'd',
      config: { url: 'url-d' },
      dependencies: [],
    })

    const items: Array<[string, string]> = [
      ['a', 'data-a'],
      ['b', 'data-b'],
      ['c', 'data-c'],
      ['d', 'data-d'],
    ]

    await Effect.runPromise(
      executeTopoForAll({
        items,
        fn: Effect.fnUntraced(function* ([id]) {
          currentConcurrent++
          concurrent.push(currentConcurrent)
          yield* Effect.sleep(50)
          currentConcurrent--
          return id
        }),
        graph,
        options: { mode: 'topo-parallel' as ExecutionMode, maxParallel: 2 },
      }),
    )

    // Max concurrent should never exceed 2
    expect(Math.max(...concurrent)).toBeLessThanOrEqual(2)
  })
})
