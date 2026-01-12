/**
 * Dependency graph utilities
 *
 * Build and traverse dependency graphs for topological execution
 */

import { Effect, Schema } from 'effect'

/** Error when a cycle is detected in the dependency graph */
export class CycleError extends Schema.TaggedError<CycleError>()('CycleError', {
  cycle: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** A node in the dependency graph */
export type GraphNode<T> = {
  id: string
  data: T
  /** IDs of nodes this node depends on */
  dependencies: string[]
}

/** Dependency graph */
export type Graph<T> = {
  nodes: Map<string, GraphNode<T>>
}

/** Create an empty graph */
export const empty = <T>(): Graph<T> => ({
  nodes: new Map(),
})

/** Add a node to the graph */
export const addNode = <T>(
  graph: Graph<T>,
  id: string,
  data: T,
  dependencies: string[] = [],
): Graph<T> => {
  const newNodes = new Map(graph.nodes)
  newNodes.set(id, { id, data, dependencies })
  return { nodes: newNodes }
}

/** Get all node IDs */
export const nodeIds = <T>(graph: Graph<T>): string[] => Array.from(graph.nodes.keys())

/** Get a node by ID */
export const getNode = <T>(graph: Graph<T>, id: string): GraphNode<T> | undefined =>
  graph.nodes.get(id)

/**
 * Topologically sort nodes using Kahn's algorithm
 * Returns nodes in order such that dependencies come before dependents
 */
export const topologicalSort = <T>(graph: Graph<T>): Effect.Effect<string[], CycleError> =>
  Effect.gen(function* () {
    const nodes = graph.nodes
    const result: string[] = []

    // Calculate in-degrees (number of dependencies)
    const inDegree = new Map<string, number>()
    for (const [id] of nodes) {
      inDegree.set(id, 0)
    }

    // Count dependencies for each node
    for (const [id, node] of nodes) {
      for (const dep of node.dependencies) {
        // Only count dependencies that exist in the graph
        if (nodes.has(dep)) {
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
        }
      }
    }

    // Find all nodes with no dependencies (in-degree 0)
    const queue: string[] = []
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id)
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!
      result.push(current)

      // For each node that depends on current, decrease its in-degree
      for (const [id, node] of nodes) {
        if (node.dependencies.includes(current)) {
          const newDegree = (inDegree.get(id) ?? 1) - 1
          inDegree.set(id, newDegree)
          if (newDegree === 0) {
            queue.push(id)
          }
        }
      }
    }

    // If we didn't process all nodes, there's a cycle
    if (result.length !== nodes.size) {
      // Find nodes involved in cycle
      const cycleNodes = Array.from(nodes.keys()).filter((id) => !result.includes(id))
      return yield* new CycleError({
        cycle: cycleNodes,
        message: `Circular dependency detected: ${cycleNodes.join(' -> ')}`,
      })
    }

    return result
  })

/**
 * Group nodes into layers for parallel execution
 * Each layer contains nodes whose dependencies are all in previous layers
 */
export const toLayers = <T>(graph: Graph<T>): Effect.Effect<string[][], CycleError> =>
  Effect.gen(function* () {
    const nodes = graph.nodes
    const layers: string[][] = []
    const placed = new Set<string>()

    while (placed.size < nodes.size) {
      const layer: string[] = []

      for (const [id, node] of nodes) {
        if (placed.has(id)) continue

        // Check if all dependencies are placed
        const depsPlaced = node.dependencies.every((dep) => !nodes.has(dep) || placed.has(dep))

        if (depsPlaced) {
          layer.push(id)
        }
      }

      if (layer.length === 0) {
        // No progress means cycle
        const remaining = Array.from(nodes.keys()).filter((id) => !placed.has(id))
        return yield* new CycleError({
          cycle: remaining,
          message: `Circular dependency detected: ${remaining.join(' -> ')}`,
        })
      }

      layers.push(layer)
      for (const id of layer) {
        placed.add(id)
      }
    }

    return layers
  })

import type { MemberConfigSource } from './loader.ts'
import type { RepoConfig } from './config.ts'

/**
 * Build a dependency graph from member configs
 * Each member repo depends on the repos it declares in its deps
 */
export const buildFromMemberConfigs = (configs: MemberConfigSource[]): Graph<RepoConfig> => {
  let graph = empty<RepoConfig>()

  // First pass: collect all repos from deps
  const allRepos = new Map<string, RepoConfig>()
  for (const source of configs) {
    if (source.config.deps) {
      for (const [name, depConfig] of Object.entries(source.config.deps)) {
        if (!allRepos.has(name)) {
          allRepos.set(name, {
            url: depConfig.url,
            rev: depConfig.rev,
            install: depConfig.install,
          })
        }
      }
    }
  }

  // Add all repos as nodes
  for (const [name, config] of allRepos) {
    graph = addNode(graph, name, config, [])
  }

  // Add member repos with their dependencies
  for (const source of configs) {
    const repoName = source.repoName
    const deps = source.config.deps ? Object.keys(source.config.deps) : []

    // Get existing node data or create empty config for member repo
    const existingNode = getNode(graph, repoName)
    const nodeData = existingNode?.data ?? { url: '' }

    graph = addNode(graph, repoName, nodeData, deps)
  }

  return graph
}
