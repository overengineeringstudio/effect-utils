/**
 * Repository dependency graph using Effect.Graph
 *
 * Wraps Effect.Graph with string ID mapping for repo names,
 * providing topological sort and layer grouping for parallel execution.
 */

import { Effect, Graph, Option, Schema } from 'effect'

import type { RepoConfig } from './config.ts'
import type { MemberConfigSource } from './loader.ts'

/** Error when a cycle is detected in the dependency graph */
export class CycleError extends Schema.TaggedError<CycleError>()('CycleError', {
  cycle: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** Repository graph with bidirectional ID mapping */
export type RepoGraph = {
  readonly graph: Graph.DirectedGraph<RepoConfig, void>
  readonly idToIndex: ReadonlyMap<string, Graph.NodeIndex>
  readonly indexToId: ReadonlyMap<Graph.NodeIndex, string>
}

/** Create an empty repo graph */
export const empty = (): RepoGraph => ({
  graph: Graph.directed<RepoConfig, void>(),
  idToIndex: new Map(),
  indexToId: new Map(),
})

/** Add a repo to the graph (returns new graph) */
export const addRepo = (
  repoGraph: RepoGraph,
  id: string,
  config: RepoConfig,
  dependencies: string[] = [],
): RepoGraph => {
  const idToIndex = new Map(repoGraph.idToIndex)
  const indexToId = new Map(repoGraph.indexToId)

  const graph = Graph.mutate(repoGraph.graph, (mutable) => {
    // Add node if not exists
    let nodeIndex = idToIndex.get(id)
    if (nodeIndex === undefined) {
      nodeIndex = Graph.addNode(mutable, config)
      idToIndex.set(id, nodeIndex)
      indexToId.set(nodeIndex, id)
    }

    // Add dependency edges
    for (const depId of dependencies) {
      let depIndex = idToIndex.get(depId)
      if (depIndex === undefined) {
        // Create dependency node with empty config if not exists
        depIndex = Graph.addNode(mutable, { url: '' })
        idToIndex.set(depId, depIndex)
        indexToId.set(depIndex, depId)
      }
      // Edge from dependency to dependent (dep -> node)
      // This means: depIndex must be processed before nodeIndex
      if (!Graph.hasEdge(mutable, depIndex, nodeIndex)) {
        Graph.addEdge(mutable, depIndex, nodeIndex, undefined)
      }
    }
  })

  return { graph, idToIndex, indexToId }
}

/** Get all repo IDs in the graph */
export const repoIds = (repoGraph: RepoGraph): string[] => Array.from(repoGraph.idToIndex.keys())

/** Get a repo's config by ID */
export const getRepo = (repoGraph: RepoGraph, id: string): RepoConfig | undefined => {
  const index = repoGraph.idToIndex.get(id)
  if (index === undefined) return undefined
  return Option.getOrUndefined(Graph.getNode(repoGraph.graph, index))
}

/** Get a repo's dependencies by ID */
export const getDependencies = (repoGraph: RepoGraph, id: string): string[] => {
  const index = repoGraph.idToIndex.get(id)
  if (index === undefined) return []

  // Get incoming neighbors (nodes that point to this node = dependencies)
  const depIndices = Graph.neighborsDirected(repoGraph.graph, index, 'incoming')
  return depIndices.map((idx) => repoGraph.indexToId.get(idx)!).filter(Boolean)
}

/**
 * Topologically sort repos using Kahn's algorithm
 * Returns repo IDs in order such that dependencies come before dependents
 */
export const topologicalSort = (repoGraph: RepoGraph): Effect.Effect<string[], CycleError> =>
  Effect.gen(function* () {
    const { graph, indexToId } = repoGraph

    // Check for cycles first
    if (!Graph.isAcyclic(graph)) {
      // Find cycle using strongly connected components
      const sccs = Graph.stronglyConnectedComponents(graph)
      const cycleComponent = sccs.find((c) => c.length > 1)
      const cycleIds = cycleComponent?.map((idx) => indexToId.get(idx) ?? `unknown-${idx}`) ?? []

      return yield* new CycleError({
        cycle: cycleIds,
        message: `Circular dependency detected: ${cycleIds.join(' -> ')}`,
      })
    }

    // Use Effect.Graph's topo iterator
    const sorted: string[] = []
    for (const [index] of Graph.topo(graph)) {
      const id = indexToId.get(index)
      if (id !== undefined) {
        sorted.push(id)
      }
    }

    return sorted
  })

/**
 * Group repos into layers for parallel execution
 * Each layer contains repos whose dependencies are all in previous layers
 */
export const toLayers = (repoGraph: RepoGraph): Effect.Effect<string[][], CycleError> =>
  Effect.gen(function* () {
    const { graph, idToIndex, indexToId } = repoGraph

    // Check for cycles first
    if (!Graph.isAcyclic(graph)) {
      const sccs = Graph.stronglyConnectedComponents(graph)
      const cycleComponent = sccs.find((c) => c.length > 1)
      const cycleIds = cycleComponent?.map((idx) => indexToId.get(idx) ?? `unknown-${idx}`) ?? []

      return yield* new CycleError({
        cycle: cycleIds,
        message: `Circular dependency detected: ${cycleIds.join(' -> ')}`,
      })
    }

    const nodeCount = Graph.nodeCount(graph)
    if (nodeCount === 0) return []

    const layers: string[][] = []
    const placed = new Set<Graph.NodeIndex>()

    // Calculate in-degrees for all nodes
    const inDegree = new Map<Graph.NodeIndex, number>()
    for (const [index] of graph.nodes) {
      const incoming = Graph.neighborsDirected(graph, index, 'incoming')
      inDegree.set(index, incoming.length)
    }

    while (placed.size < nodeCount) {
      const layer: string[] = []

      for (const [index] of graph.nodes) {
        if (placed.has(index)) continue

        // Check if all dependencies (incoming neighbors) are placed
        const deps = Graph.neighborsDirected(graph, index, 'incoming')
        const allDepsPlaced = deps.every((dep) => placed.has(dep))

        if (allDepsPlaced) {
          const id = indexToId.get(index)
          if (id !== undefined) {
            layer.push(id)
          }
        }
      }

      if (layer.length === 0 && placed.size < nodeCount) {
        // This shouldn't happen if isAcyclic passed, but guard anyway
        const remaining = Array.from(graph.nodes.keys())
          .filter((idx) => !placed.has(idx))
          .map((idx) => indexToId.get(idx) ?? `unknown-${idx}`)

        return yield* new CycleError({
          cycle: remaining,
          message: `Circular dependency detected: ${remaining.join(' -> ')}`,
        })
      }

      // Mark layer nodes as placed
      for (const id of layer) {
        const index = idToIndex.get(id)
        if (index !== undefined) {
          placed.add(index)
        }
      }

      if (layer.length > 0) {
        layers.push(layer)
      }
    }

    return layers
  })

/**
 * Build a dependency graph from member configs
 * Each member repo depends on the repos it declares in its deps
 */
export const fromMemberConfigs = (configs: MemberConfigSource[]): RepoGraph => {
  let repoGraph = empty()

  // First pass: collect all repos from deps
  const allRepos = new Map<string, RepoConfig>()
  for (const source of configs) {
    if (source.config.deps) {
      for (const [name, depConfig] of Object.entries(source.config.deps)) {
        if (!allRepos.has(name)) {
          allRepos.set(name, {
            url: depConfig.url,
            rev: depConfig.rev,
          })
        }
      }
    }
  }

  // Add all dep repos as nodes (no dependencies)
  for (const [name, config] of allRepos) {
    repoGraph = addRepo(repoGraph, name, config, [])
  }

  // Add member repos with their dependencies
  for (const source of configs) {
    const repoName = source.repoName
    const deps = source.config.deps ? Object.keys(source.config.deps) : []

    // Get existing config or create empty one for member repo
    const existingConfig = getRepo(repoGraph, repoName)
    const nodeConfig = existingConfig ?? { url: '' }

    repoGraph = addRepo(repoGraph, repoName, nodeConfig, deps)
  }

  return repoGraph
}
