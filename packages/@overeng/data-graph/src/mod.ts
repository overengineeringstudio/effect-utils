import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from 'effect'

import {
  ContentDescriptor,
  ContentManifest,
  canonicalJsonBytes,
  canonicalJsonString,
  descriptorForCanonicalJson,
  getBytes,
  getPinnedManifestDescriptor,
  makeFileSystemContentStore,
  pinManifest,
  putBytes,
  putManifest,
  type ContentAddressError,
  type ContentDigest,
  type ContentManifestEntry,
} from '@overeng/content-address'

/** Consumers own the meaning and canonicalization of scope and output bytes. */
export const NodeKind = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand('DataGraph.NodeKind'),
)
export type NodeKind = typeof NodeKind.Type
export const NodeKey = Schema.Struct({
  kind: NodeKind,
  scope: Schema.Json,
  output: Schema.optional(Schema.NonEmptyString),
})
export type NodeKey = typeof NodeKey.Type
export const Recipe = Schema.Struct({
  kind: NodeKind,
  version: Schema.NonEmptyString,
  config: Schema.Json,
})
export type Recipe = typeof Recipe.Type

export class GraphError extends Schema.TaggedError<GraphError>()('GraphError', {
  nodeId: Schema.String,
  message: Schema.String,
}) {}
export class GraphExecutionError extends Schema.TaggedError<GraphExecutionError>()(
  'GraphExecutionError',
  {
    message: Schema.String,
  },
) {}
export type GraphFailure =
  | GraphError
  | GraphExecutionError
  | ContentAddressError
  | Schema.SchemaError

/** Store operations preserve the content-address package's descriptor and pin contracts. */
export interface GraphStoreApi {
  readonly withWriteLock: <TValue, TError, TEnvironment>(
    effect: Effect.Effect<TValue, TError, TEnvironment>,
  ) => Effect.Effect<TValue, TError, TEnvironment>
  readonly put: (
    bytes: Uint8Array,
    mediaType: string,
    codec?: string,
    schemaVersion?: number,
  ) => Effect.Effect<ContentDescriptor, ContentAddressError>
  readonly get: (descriptor: ContentDescriptor) => Effect.Effect<Uint8Array, ContentAddressError>
  readonly manifest: (
    manifest: ContentManifest,
  ) => Effect.Effect<ContentDescriptor, ContentAddressError>
  readonly pin: (
    name: string,
    descriptor: ContentDescriptor,
  ) => Effect.Effect<void, ContentAddressError>
  readonly lookup: (
    name: string,
  ) => Effect.Effect<Option.Option<ContentDescriptor>, ContentAddressError>
}
// Separate layers for the same filesystem root share one process-local writer.
const writers = new Map<string, Semaphore.Semaphore>()
export class GraphStore extends Context.Service<GraphStore, GraphStoreApi>()(
  'DataGraph.GraphStore',
) {
  static fileSystem(root: string): Layer.Layer<GraphStore> {
    const store = makeFileSystemContentStore({ root })
    const identity = resolve(root)
    let writer = writers.get(identity)
    if (writer === undefined) {
      writer = Semaphore.makeUnsafe(1)
      writers.set(identity, writer)
    }
    const lock = writer
    return Layer.succeed(this, {
      withWriteLock: (effect) => lock.withPermits(1)(effect),
      put: (bytes, mediaType, codec, schemaVersion) =>
        putBytes({
          store,
          bytes,
          mediaType,
          ...(codec === undefined ? {} : { codec }),
          ...(schemaVersion === undefined ? {} : { schemaVersion }),
        }),
      get: (descriptor) => getBytes({ store, descriptor }),
      manifest: (manifest) => putManifest({ store, manifest }),
      pin: (name, manifestDescriptor) => pinManifest({ store, name, manifestDescriptor }),
      lookup: (name) =>
        getPinnedManifestDescriptor({ store, name }).pipe(
          Effect.map(Option.some),
          Effect.catchTag('ContentPinMissingError', () => Effect.succeed(Option.none())),
        ),
    })
  }
}

export interface OutputBytes {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly codec?: string
  readonly schemaVersion?: number
}
export type Execution =
  | {
      readonly _tag: 'Accepted'
      readonly outputs: Readonly<Record<string, OutputBytes>>
      readonly receipts: ReadonlyArray<ContentDescriptor>
    }
  | {
      readonly _tag: 'Rejected'
      readonly reason: string
      readonly receipts: ReadonlyArray<ContentDescriptor>
    }
export interface ExecutionContext {
  readonly scope: Schema.Json
  readonly inputs: Readonly<Record<string, ContentDescriptor>>
}
/** Executor services must be supplied by the consumer before constructing a definition. */
export interface NodeDef {
  readonly _tag: 'Derive' | 'Observe'
  readonly kind: NodeKind
  readonly outputs: ReadonlyArray<string>
  readonly recipe: (scope: Schema.Json) => Recipe
  readonly inputs: (scope: Schema.Json) => Readonly<Record<string, NodeRef>>
  readonly execute: (
    context: ExecutionContext,
  ) => Effect.Effect<
    Execution,
    GraphExecutionError | ContentAddressError | Schema.SchemaError,
    GraphStore
  >
}
export interface NodeRef {
  readonly node: NodeDef
  readonly scope: Schema.Json
  readonly output: string
}
export const ref = (node: NodeDef, scope: Schema.Json, output: string): NodeRef => ({
  node,
  scope,
  output,
})
/** Stable node identity excludes the selected output dimension. */
export const nodeId = ({ kind, scope }: NodeKey): string =>
  canonicalJsonString({ schema: NodeKey, value: { kind, scope } })
export const nodeIdDigest = ({ kind, scope }: NodeKey): ContentDigest =>
  descriptorForCanonicalJson({ schema: NodeKey, value: { kind, scope }, schemaVersion: 1 }).digest
const hex = (digest: ContentDigest): string => digest.slice('sha256:'.length)
const headPin = (key: NodeKey): string => `data-graph/heads/${hex(nodeIdDigest(key))}`
const manifest = (role: string, entries: ReadonlyArray<ContentManifestEntry>): ContentManifest =>
  ContentManifest.make({ schemaVersion: 1, role, entries })
const actionManifest = (
  recipe: ContentDescriptor,
  inputs: Readonly<Record<string, ContentDescriptor>>,
): ContentManifest =>
  manifest('data-graph.action', [
    { role: 'recipe', descriptor: recipe },
    ...Object.keys(inputs).toSorted().map((name) => ({
      role: 'input',
      logicalPath: name,
      descriptor: inputs[name]!,
    })),
  ])

/** Pure action identity, using exactly the descriptors persisted during a pull. */
export const actionKey = (
  recipe: Recipe,
  inputs: Readonly<Record<string, ContentDescriptor>>,
): ContentDigest =>
  descriptorForCanonicalJson({
    schema: ContentManifest,
    value: actionManifest(
      descriptorForCanonicalJson({ schema: Recipe, value: recipe, schemaVersion: 1 }),
      inputs,
    ),
    schemaVersion: 1,
  }).digest
const decoder = new TextDecoder()
const readJson = Effect.fn('DataGraph.readJson')(function* <TSchema extends Schema.Codec<unknown>>(
  schema: TSchema,
  descriptor: ContentDescriptor,
) {
  const store = yield* GraphStore
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    decoder.decode(yield* store.get(descriptor)),
  )
})
export const writeJson = Effect.fn('DataGraph.writeJson')(function* <
  TSchema extends Schema.Codec<unknown>,
>(schema: TSchema, value: Schema.Schema.Type<TSchema>) {
  const store = yield* GraphStore
  return yield* store.put(
    canonicalJsonBytes({ schema, value }),
    'application/json',
    'canonical-json',
    1,
  )
})

export const AttemptStatus = Schema.Struct({
  _tag: Schema.Literals(['Accepted', 'Rejected', 'Failed']),
  action: ContentDescriptor,
  reason: Schema.optional(Schema.String),
  materialization: Schema.optional(ContentDescriptor),
  attempt: Schema.optional(ContentDescriptor),
})
export type AttemptStatus = typeof AttemptStatus.Type
const attemptPin = (key: NodeKey): string => `data-graph/attempts/${hex(nodeIdDigest(key))}`
const publishStatus = Effect.fn('DataGraph.publishStatus')(function* (
  key: NodeKey,
  status: AttemptStatus,
) {
  const store = yield* GraphStore
  const descriptor = yield* writeJson(AttemptStatus, status)
  const wrapper = yield* store.manifest(manifest('data-graph.selection-status', [
    { role: 'status', descriptor },
    { role: 'action', descriptor: status.action },
    ...(status.attempt === undefined ? [] : [{ role: 'attempt', descriptor: status.attempt }]),
    ...(status.materialization === undefined ? [] : [
      { role: 'materialization', descriptor: status.materialization },
    ]),
  ]))
  yield* store.pin(attemptPin(key), wrapper)
})
/** Unsuccessful invocations are recorded without publishing a selected head or action pin. */
const recordAttempt = Effect.fn('DataGraph.recordAttempt')(function* (
  key: NodeKey,
  action: ContentDescriptor,
  statusTag: 'Failed' | 'Rejected',
  reason: string,
  receipts: ReadonlyArray<ContentDescriptor>,
) {
  const store = yield* GraphStore
  for (const descriptor of receipts) yield* store.get(descriptor)
  const status = yield* writeJson(Schema.Json, { _tag: statusTag, attemptId: randomUUID(), reason })
  const attempt = yield* store.manifest(
    manifest('data-graph.attempt', [
      { role: 'action', descriptor: action },
      { role: 'status', descriptor: status },
      ...receipts.map((descriptor) => ({ role: 'receipt', descriptor })),
    ]),
  )
  yield* publishStatus(key, { _tag: statusTag, action, reason, attempt })
  return attempt
})

export const Head = Schema.TaggedStruct('Head', {
  schemaVersion: Schema.Literal(1),
  key: NodeKey,
  materialization: ContentDescriptor,
  action: ContentDescriptor,
  lastConfirmedAt: Schema.optional(Schema.Finite),
})
export type Head = typeof Head.Type
export const getHead = Effect.fn('DataGraph.getHead')(function* (key: NodeKey) {
  const store = yield* GraphStore
  const pinned = yield* store.lookup(headPin(key))
  if (Option.isNone(pinned)) return Option.none<Head>()
  const wrapper = yield* readJson(ContentManifest, pinned.value)
  const record = wrapper.entries.find((entry) => entry.role === 'confirmation')
  if (wrapper.role !== 'data-graph.head' || record === undefined)
    return yield* new GraphError({ nodeId: nodeId(key), message: 'Invalid head manifest' })
  const head = yield* readJson(Head, record.descriptor)
  if (nodeId(head.key) !== nodeId(key))
    return yield* new GraphError({ nodeId: nodeId(key), message: 'Head identity mismatch' })
  const bound = wrapper.entries.find((entry) => entry.role === 'materialization')
  if (bound?.descriptor.digest !== head.materialization.digest)
    return yield* new GraphError({ nodeId: nodeId(key), message: 'Head materialization mismatch' })
  yield* readOutputs(head.materialization, key.kind, head.action)
  return Option.some(head)
})
const selectHead = Effect.fn('DataGraph.selectHead')(function* (head: Head) {
  const store = yield* GraphStore
  const record = yield* writeJson(Head, head)
  const wrapper = yield* store.manifest(
    manifest('data-graph.head', [
      { role: 'confirmation', descriptor: record },
      { role: 'materialization', descriptor: head.materialization },
    ]),
  )
  yield* store.pin(headPin(head.key), wrapper)
  yield* publishStatus(head.key, {
    _tag: 'Accepted', action: head.action, materialization: head.materialization,
  })
})

export type Outcome =
  | { readonly _tag: 'Reused' }
  | { readonly _tag: 'Executed'; readonly changedOutputs: ReadonlyArray<string> }
  | { readonly _tag: 'Rejected'; readonly attempt: ContentDescriptor }
export interface NodeOutcome {
  readonly nodeId: string
  readonly kind: NodeKind
  readonly outcome: Outcome
  readonly materialization: ContentDescriptor
  readonly outputs: Readonly<Record<string, ContentDescriptor>>
}
export interface MaterializeResult extends NodeOutcome {
  readonly output: ContentDescriptor
  readonly trace: ReadonlyArray<NodeOutcome>
}
/** Historical materializations retain their own output set across recipe upgrades. */
const readOutputs = Effect.fn('DataGraph.readOutputs')(function* (
  descriptor: ContentDescriptor,
  kind: NodeKind,
  action?: ContentDescriptor,
) {
  const store = yield* GraphStore
  const record = yield* readJson(ContentManifest, descriptor)
  const boundAction = record.entries.find((entry) => entry.role === 'action')
  if (
    record.role !== 'data-graph.materialization' ||
    boundAction === undefined ||
    (action !== undefined && boundAction.descriptor.digest !== action.digest)
  ) {
    return yield* new GraphError({
      nodeId: kind,
      message: 'Invalid materialization or mismatched action',
    })
  }
  const actionRecord = yield* readJson(ContentManifest, boundAction.descriptor)
  if (actionRecord.role !== 'data-graph.action')
    return yield* new GraphError({ nodeId: kind, message: 'Invalid action manifest' })
  for (const entry of actionRecord.entries) yield* store.get(entry.descriptor)
  const outputs: Record<string, ContentDescriptor> = Object.create(null)
  for (const entry of record.entries) {
    yield* store.get(entry.descriptor)
    if (entry.role === 'output' && entry.logicalPath !== undefined) {
      if (Object.hasOwn(outputs, entry.logicalPath))
        return yield* new GraphError({
          nodeId: kind,
          message: 'Duplicate output in materialization',
        })
      outputs[entry.logicalPath] = entry.descriptor
    }
  }
  return outputs
})

/** Current selections and cache hits must match the current declared output contract. */
const outputsOf = Effect.fn('DataGraph.outputsOf')(function* (
  descriptor: ContentDescriptor,
  node: NodeDef,
  action?: ContentDescriptor,
) {
  const outputs = yield* readOutputs(descriptor, node.kind, action)
  if (Object.keys(outputs).toSorted().join('\0') !== [...node.outputs].toSorted().join('\0'))
    return yield* new GraphError({
      nodeId: node.kind,
      message: 'Materialization does not match declared outputs',
    })
  return outputs
})

/** Serialized pull; explicit refresh IDs authorize observations, never time-based hashes. */
const materializeUnlocked = Effect.fn('DataGraph.materializeUnlocked')(function* (
  target: NodeRef,
  options: { readonly refresh?: ReadonlyArray<string> } = {},
) {
  const store = yield* GraphStore
  const trace: NodeOutcome[] = []
  const completed = new Map<string, NodeOutcome>()
  const visiting = new Set<string>()
  const definitions = new Map<NodeKind, NodeDef>()
  const refresh = new Set(options.refresh ?? [])
  const visit = (reference: NodeRef): Effect.Effect<NodeOutcome, GraphFailure, GraphStore> =>
    Effect.gen(function* () {
      const { node, scope } = reference
      const key = { kind: node.kind, scope }
      const id = nodeId(key)
      const invalid = (message: string) => new GraphError({ nodeId: id, message })
      if (!node.outputs.includes(reference.output))
        return yield* invalid(`Undeclared output: ${reference.output}`)
      if (
        node.outputs.length === 0 ||
        new Set(node.outputs).size !== node.outputs.length ||
        node.outputs.some(
          (name) => name.trim() !== name || name.length === 0 || name.includes('\0'),
        )
      )
        return yield* invalid('Output names must be unique, non-empty, trimmed strings without NUL')
      const registered = definitions.get(node.kind)
      if (registered !== undefined && registered !== node)
        return yield* invalid('Conflicting definitions for one node kind')
      definitions.set(node.kind, node)
      if (visiting.has(id)) return yield* invalid('Declared dependency cycle')
      const previousResult = completed.get(id)
      if (previousResult !== undefined) return previousResult
      visiting.add(id)
      const inputs: Record<string, ContentDescriptor> = Object.create(null)
      const declared = node.inputs(scope)
      for (const name of Object.keys(declared).toSorted()) {
        if (name.length === 0 || name.trim() !== name)
          return yield* invalid('Input names must be non-empty trimmed strings')
        const upstream = declared[name]
        if (upstream === undefined) return yield* invalid('Missing declared input')
        const resolved = yield* visit(upstream)
        const output = resolved.outputs[upstream.output]
        if (output === undefined) return yield* invalid('Missing upstream output')
        inputs[name] = output
      }
      const recipe = node.recipe(scope)
      if (recipe.kind !== node.kind) return yield* invalid('Recipe kind must match node kind')
      const recipeDescriptor = yield* writeJson(Recipe, recipe)
      const action = yield* store.manifest(
        actionManifest(recipeDescriptor, inputs),
      )
      const previous = yield* getHead(key)
      const finish = (
        outcome: Outcome,
        descriptor: ContentDescriptor,
        outputs: Readonly<Record<string, ContentDescriptor>>,
      ): NodeOutcome => {
        const result = {
          nodeId: id,
          kind: node.kind,
          outcome,
          materialization: descriptor,
          outputs,
        }
        visiting.delete(id)
        completed.set(id, result)
        trace.push(result)
        return result
      }
      if (node._tag === 'Observe' && !refresh.has(id)) {
        if (Option.isNone(previous))
          return yield* invalid(
            'Observation requires an explicit refresh before its first selection',
          )
        if (previous.value.action.digest !== action.digest)
          return yield* invalid('Observation recipe or inputs changed; explicit refresh required')
        return finish(
          { _tag: 'Reused' },
          previous.value.materialization,
          yield* outputsOf(previous.value.materialization, node, action),
        )
      }
      if (node._tag === 'Derive') {
        const cached = yield* store.lookup(`data-graph/actions/${hex(action.digest)}`)
        if (Option.isSome(cached)) {
          const outputs = yield* outputsOf(cached.value, node, action)
          yield* selectHead(
            Head.make({ schemaVersion: 1, key, action, materialization: cached.value }),
          )
          return finish({ _tag: 'Reused' }, cached.value, outputs)
        }
      }
      const execution = yield* node.execute({ scope, inputs }).pipe(Effect.result)
      if (execution._tag === 'Failure') {
        yield* recordAttempt(key, action, 'Failed', String(execution.failure), [])
        return yield* execution.failure
      }
      if (execution.success._tag === 'Rejected') {
        const attempt = yield* recordAttempt(
          key,
          action,
          'Rejected',
          execution.success.reason,
          execution.success.receipts,
        )
        if (node._tag === 'Derive')
          return yield* invalid('Deterministic executor rejected its output; attempt recorded')
        if (Option.isNone(previous))
          return yield* invalid(
            `Observation rejected without a selected head; attempt ${attempt.digest}`,
          )
        return finish(
          { _tag: 'Rejected', attempt },
          previous.value.materialization,
          yield* readOutputs(previous.value.materialization, node.kind),
        )
      }
      const accepted = execution.success
      if (
        Object.keys(accepted.outputs).toSorted().join('\0') !==
        [...node.outputs].toSorted().join('\0')
      )
        return yield* invalid('Executor outputs must exactly match declared outputs')
      const outputs: Record<string, ContentDescriptor> = Object.create(null)
      for (const name of [...node.outputs].toSorted()) {
        const payload = accepted.outputs[name]
        if (payload === undefined) return yield* invalid('Missing executor output')
        outputs[name] = yield* store.put(
          payload.bytes,
          payload.mediaType,
          payload.codec,
          payload.schemaVersion,
        )
      }
      for (const descriptor of accepted.receipts) yield* store.get(descriptor)
      const descriptor = yield* store.manifest(
        manifest('data-graph.materialization', [
          { role: 'action', descriptor: action },
          ...Object.keys(outputs)
            .toSorted()
            .map((name) => ({ role: 'output', logicalPath: name, descriptor: outputs[name]! })),
          ...accepted.receipts.map((receipt) => ({ role: 'receipt', descriptor: receipt })),
        ]),
      )
      const priorOutputs: Record<string, ContentDescriptor> = Option.isSome(previous)
        ? yield* readOutputs(previous.value.materialization, node.kind)
        : Object.create(null)
      const changedOutputs = [...new Set([...Object.keys(outputs), ...Object.keys(priorOutputs)])]
        .toSorted()
        .filter((name) => outputs[name]?.digest !== priorOutputs[name]?.digest)
      if (node._tag === 'Derive')
        yield* store.pin(`data-graph/actions/${hex(action.digest)}`, descriptor)
      yield* selectHead(
        Head.make({
          schemaVersion: 1,
          key,
          action,
          materialization: descriptor,
          ...(node._tag === 'Observe' ? { lastConfirmedAt: yield* Clock.currentTimeMillis } : {}),
        }),
      )
      return finish({ _tag: 'Executed', changedOutputs }, descriptor, outputs)
    })
  const result = yield* visit(target)
  const output = result.outputs[target.output]
  if (output === undefined)
    return yield* new GraphError({ nodeId: result.nodeId, message: 'Missing requested output' })
  return { ...result, output, trace } satisfies MaterializeResult
})

export const materialize = Effect.fn('DataGraph.materialize')(function* (
  target: NodeRef,
  options: { readonly refresh?: ReadonlyArray<string> } = {},
) {
  const store = yield* GraphStore
  return yield* store.withWriteLock(materializeUnlocked(target, options))
})

export interface SelectionStatus {
  readonly head: Option.Option<Head>
  readonly action: ContentDigest
  readonly acceptance: 'Missing' | 'Current' | 'StaleAction'
  readonly latestAttempt: Option.Option<AttemptStatus>
}

/** Read-only policy status: never executes a graph or refreshes a confirmation. */
export const getSelectionStatus = Effect.fn('DataGraph.getSelectionStatus')(function* (
  target: NodeRef,
) {
  const store = yield* GraphStore
  const visiting = new Set<string>()
  const completed = new Map<string, SelectionStatus>()
  const visit = (reference: NodeRef): Effect.Effect<SelectionStatus, GraphFailure, GraphStore> =>
    Effect.gen(function* () {
      const { node, scope } = reference
      const key = { kind: node.kind, scope }
      const id = nodeId(key)
      if (visiting.has(id))
        return yield* new GraphError({ nodeId: id, message: 'Declared dependency cycle' })
      const prior = completed.get(id)
      if (prior !== undefined) return prior
      visiting.add(id)
      const inputs: Record<string, ContentDescriptor> = Object.create(null)
      let upstreamCurrent = true
      for (const [name, upstream] of Object.entries(node.inputs(scope))) {
        const status = yield* visit(upstream)
        if (Option.isNone(status.head))
          return yield* new GraphError({ nodeId: id, message: 'Missing selected upstream' })
        const outputs = yield* readOutputs(status.head.value.materialization, upstream.node.kind)
        const output = outputs[upstream.output]
        if (output === undefined)
          return yield* new GraphError({ nodeId: id, message: 'Missing selected upstream output' })
        inputs[name] = output
        upstreamCurrent &&= status.acceptance === 'Current'
      }
      const action = actionKey(node.recipe(scope), inputs)
      const head = yield* getHead(key)
      const pinned = yield* store.lookup(attemptPin(key))
      let latestAttempt = Option.none<AttemptStatus>()
      if (Option.isSome(pinned)) {
        const wrapper = yield* readJson(ContentManifest, pinned.value)
        const status = wrapper.entries.find((entry) => entry.role === 'status')
        if (wrapper.role !== 'data-graph.selection-status' || status === undefined)
          return yield* new GraphError({ nodeId: id, message: 'Invalid selection status' })
        for (const entry of wrapper.entries) yield* store.get(entry.descriptor)
        latestAttempt = Option.some(yield* readJson(AttemptStatus, status.descriptor))
      }
      const result: SelectionStatus = {
        head, action, latestAttempt,
        acceptance: Option.isNone(head) ? 'Missing'
          : upstreamCurrent && head.value.action.digest === action ? 'Current' : 'StaleAction',
      }
      visiting.delete(id)
      completed.set(id, result)
      return result
    })
  return yield* store.withWriteLock(visit(target))
})

export const checkFreshness = ({
  status, now, maxAge,
}: { readonly status: SelectionStatus; readonly now: number; readonly maxAge: number }): boolean =>
  status.acceptance === 'Current' && Option.isSome(status.head) &&
  !isStale(status.head.value, now, maxAge)

export interface RefreshRequest<TTier = unknown> {
  readonly _tag: 'Refresh'
  readonly key: NodeKey
  readonly nodeId: string
  readonly overdueBy: number
  readonly tier: TTier
}
export const isStale = (head: Head, now: number, maxAge: number): boolean =>
  head.lastConfirmedAt === undefined || now - head.lastConfirmedAt >= maxAge
/** Consumer-ranked opaque tiers first, then overdue age, then stable node identity. */
export const planRefresh = <TTier>({
  now, heads, policy, budget, compareTiers,
}: {
  readonly now: number
  readonly heads: ReadonlyArray<Head>
  readonly policy: (key: NodeKey) => { readonly tier: TTier; readonly maxAge: number }
  readonly compareTiers: (left: TTier, right: TTier) => number
  readonly budget: number
}): ReadonlyArray<RefreshRequest<TTier>> =>
  heads.flatMap((head): RefreshRequest<TTier>[] => {
    const { tier, maxAge } = policy(head.key)
    return isStale(head, now, maxAge) ? [{
      _tag: 'Refresh', key: head.key, nodeId: nodeId(head.key), tier,
      overdueBy: head.lastConfirmedAt === undefined ? Infinity
        : now - head.lastConfirmedAt - maxAge,
    }] : []
  }).toSorted((left, right) =>
    compareTiers(left.tier, right.tier) || right.overdueBy - left.overdueBy ||
    (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0),
  ).slice(0, Math.max(0, Math.floor(budget)))

export const DataGraph = {
  ref,
  materialize,
  nodeId,
  actionKey,
  nodeIdDigest,
  getHead,
  getSelectionStatus,
  checkFreshness,
  isStale,
  planRefresh,
} as const
