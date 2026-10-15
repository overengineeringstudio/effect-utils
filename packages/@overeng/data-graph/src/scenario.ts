import assert from 'node:assert/strict'

import { Effect, FileSystem, Option, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'

import { canonicalJsonBytes, utf8Bytes } from '@overeng/content-address'

import {
  DataGraph,
  GraphExecutionError,
  GraphStore,
  NodeKind,
  type Execution,
  type NodeDef,
  type OutputBytes,
  type MaterializeResult,
} from './mod.ts'

const jsonOutput = (value: Schema.Json): OutputBytes => ({
  bytes: canonicalJsonBytes({ schema: Schema.Json, value }),
  mediaType: 'application/json',
  codec: 'canonical-json',
  schemaVersion: 1,
})
const accepted = (outputs: Readonly<Record<string, OutputBytes>>): Execution => ({
  _tag: 'Accepted',
  outputs,
  receipts: [],
})

/** Shared script/test contract: real temporary CAS, counted executors and exact trace assertions. */
export const scenario = Effect.fn('DataGraph.scenario')(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-' })
  return yield* Effect.gen(function* () {
    const calls: Record<string, number> = {}
    const lines: string[] = []
    let sourceText = 'title=Hello\nevidence=one\n# comment'
    let observation: 'accepted' | 'rejected' | 'failed' = 'accepted'
    const scope: Schema.Json = { document: 'sample' }
    const define = (
      name: string,
      outputs: readonly string[],
      inputs: NodeDef['inputs'],
      execute: NodeDef['execute'],
      mode: NodeDef['_tag'] = 'Derive',
    ): NodeDef => {
      const kind = Schema.decodeSync(NodeKind)(name)
      return {
        _tag: mode,
        kind,
        outputs,
        inputs,
        recipe: () => ({ kind, version: '1', config: {} }),
        execute: Effect.fn(`Scenario.${name}`)(function* (context) {
          calls[name] = (calls[name] ?? 0) + 1
          return yield* execute(context)
        }),
      }
    }
    const source = define(
      'source-document',
      ['value'],
      () => ({}),
      Effect.fn('Scenario.observe')(function* () {
        if (observation === 'failed')
          return yield* new GraphExecutionError({ message: 'Source unavailable' })
        if (observation === 'rejected')
          return { _tag: 'Rejected', reason: 'Consumer policy denied selection', receipts: [] }
        return accepted({ value: { bytes: utf8Bytes(sourceText), mediaType: 'text/plain' } })
      }),
      'Observe',
    )
    const extract = define(
      'extract',
      ['value', 'evidence'],
      () => ({ source: DataGraph.ref(source, scope, 'value') }),
      Effect.fn('Scenario.extract')(function* ({ inputs }) {
        const store = yield* GraphStore
        const descriptor = inputs.source
        assert.ok(descriptor)
        const text = new TextDecoder().decode(yield* store.get(descriptor))
        const title = text
          .split('\n')
          .find((line) => line.startsWith('title='))
          ?.slice(6)
          .trim()
        const evidence = text
          .split('\n')
          .find((line) => line.startsWith('evidence='))
          ?.slice(9)
          .trim()
        assert.ok(title !== undefined && evidence !== undefined)
        return accepted({ value: jsonOutput({ title }), evidence: jsonOutput({ evidence }) })
      }),
    )
    const render = (language: string) =>
      define(
        `render-${language}`,
        ['value'],
        () => ({ value: DataGraph.ref(extract, scope, 'value') }),
        Effect.fn(`Scenario.render-${language}`)(function* ({ inputs }) {
          const store = yield* GraphStore
          assert.ok(inputs.value)
          const title = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
          )(new TextDecoder().decode(yield* store.get(inputs.value)))
          return accepted({ value: jsonOutput({ language, title: title.title }) })
        }),
      )
    const english = render('en')
    const german = render('de')
    const gate = define(
      'gate',
      ['value'],
      () => ({ evidence: DataGraph.ref(extract, scope, 'evidence') }),
      Effect.fn('Scenario.gate')(function* ({ inputs }) {
        assert.ok(inputs.evidence)
        return accepted({ value: jsonOutput({ evidenceDigest: inputs.evidence.digest }) })
      }),
    )
    const bundle = define(
      'bundle',
      ['value'],
      () => ({
        english: DataGraph.ref(english, scope, 'value'),
        german: DataGraph.ref(german, scope, 'value'),
        gate: DataGraph.ref(gate, scope, 'value'),
      }),
      Effect.fn('Scenario.bundle')(function* ({ inputs }) {
        const digests: Record<string, Schema.Json> = {}
        for (const [name, descriptor] of Object.entries(inputs)) digests[name] = descriptor.digest
        return accepted({ value: jsonOutput(digests) })
      }),
    )
    const key = { kind: source.kind, scope }
    const sourceId = DataGraph.nodeId(key)
    const refresh = { refresh: [sourceId] }
    const target = DataGraph.ref(bundle, scope, 'value')
    const expectedOrder = ['source-document', 'extract', 'render-en', 'gate', 'render-de', 'bundle']
    const assertRun = (name: string, result: MaterializeResult, outcomes: readonly string[]) => {
      assert.deepEqual(
        result.trace.map((entry) => entry.kind),
        expectedOrder,
      )
      assert.deepEqual(
        result.trace.map((entry) => entry.outcome._tag),
        outcomes,
      )
      lines.push(
        `${name}: ${result.trace.map((entry) => `${entry.kind}=${entry.outcome._tag}`).join(' | ')}`,
      )
    }
    const executed = ['Executed', 'Executed', 'Executed', 'Executed', 'Executed', 'Executed']
    const reused = ['Reused', 'Reused', 'Reused', 'Reused', 'Reused', 'Reused']
    const initial = yield* DataGraph.materialize(target, refresh)
    assertRun('initial', initial, executed)
    assert.deepEqual(calls, {
      'source-document': 1,
      extract: 1,
      'render-en': 1,
      gate: 1,
      'render-de': 1,
      bundle: 1,
    })
    const original = Option.getOrThrow(yield* DataGraph.getHead(key))
    const unchanged = yield* DataGraph.materialize(target)
    assertRun('unchanged', unchanged, reused)
    assert.deepEqual(calls, {
      'source-document': 1,
      extract: 1,
      'render-en': 1,
      gate: 1,
      'render-de': 1,
      bundle: 1,
    })
    sourceText = 'title= Hello \nevidence=one\n# different comment'
    const irrelevant = yield* DataGraph.materialize(target, refresh)
    assertRun('irrelevant', irrelevant, [
      'Executed',
      'Executed',
      'Reused',
      'Reused',
      'Reused',
      'Reused',
    ])
    const extractOutcome = irrelevant.trace[1]?.outcome
    assert.ok(extractOutcome?._tag === 'Executed')
    assert.deepEqual(extractOutcome.changedOutputs, [])
    assert.equal(
      irrelevant.trace[1]?.outputs.value?.digest,
      initial.trace[1]?.outputs.value?.digest,
    )
    sourceText = 'title=Hello\nevidence=two\n# different comment'
    const evidence = yield* DataGraph.materialize(target, refresh)
    assertRun('evidence-only', evidence, [
      'Executed',
      'Executed',
      'Reused',
      'Executed',
      'Reused',
      'Executed',
    ])
    const evidenceOutcome = evidence.trace[1]?.outcome
    assert.ok(evidenceOutcome?._tag === 'Executed')
    assert.deepEqual(evidenceOutcome.changedOutputs, ['evidence'])
    sourceText = 'title=Goodbye\nevidence=two'
    const changed = yield* DataGraph.materialize(target, refresh)
    assertRun('value-change', changed, [
      'Executed',
      'Executed',
      'Executed',
      'Reused',
      'Executed',
      'Executed',
    ])
    assert.deepEqual(calls, {
      'source-document': 4,
      extract: 4,
      'render-en': 2,
      gate: 2,
      'render-de': 2,
      bundle: 3,
    })
    const beforeConfirm = Option.getOrThrow(yield* DataGraph.getHead(key))
    yield* TestClock.adjust('1 second')
    const confirmed = yield* DataGraph.materialize(target, refresh)
    assertRun('identical-confirmation', confirmed, [
      'Executed',
      'Reused',
      'Reused',
      'Reused',
      'Reused',
      'Reused',
    ])
    const afterConfirm = Option.getOrThrow(yield* DataGraph.getHead(key))
    assert.equal(afterConfirm.lastConfirmedAt, beforeConfirm.lastConfirmedAt! + 1000)
    assert.equal(afterConfirm.materialization.digest, beforeConfirm.materialization.digest)
    const confirmationOutcome = confirmed.trace[0]?.outcome
    assert.ok(confirmationOutcome?._tag === 'Executed')
    assert.deepEqual(confirmationOutcome.changedOutputs, [])
    observation = 'failed'
    yield* TestClock.adjust('2 seconds')
    const failed = yield* DataGraph.materialize(target, refresh).pipe(Effect.result)
    assert.equal(failed._tag, 'Failure')
    if (failed._tag === 'Failure') assert.equal(failed.failure._tag, 'GraphExecutionError')
    const afterFailure = Option.getOrThrow(yield* DataGraph.getHead(key))
    assert.deepEqual(afterFailure, afterConfirm)
    const now = afterConfirm.lastConfirmedAt! + 2000
    assert.ok(DataGraph.isStale(afterFailure, now, 1500))
    const planned = DataGraph.planRefresh({
      now,
      heads: [afterFailure, { ...original, key: { ...key, scope: { document: 'older' } } }],
      policy: () => 1500,
      budget: 1,
    })
    assert.equal(planned.length, 1)
    assert.equal(planned[0]?.nodeId, DataGraph.nodeId({ ...key, scope: { document: 'older' } }))
    assert.deepEqual(
      DataGraph.planRefresh({ now, heads: [afterFailure], policy: () => 1500, budget: 1 }).map(
        (request) => request.nodeId,
      ),
      [sourceId],
    )
    assert.equal(
      DataGraph.planRefresh({ now, heads: [afterFailure], policy: () => 1500, budget: 0 }).length,
      0,
    )
    lines.push(
      'freshness: identical +1000ms; failed confirmation unchanged; stale selected under budget=1',
    )
    observation = 'rejected'
    sourceText = 'title=Denied\nevidence=three'
    const rejected = yield* DataGraph.materialize(target, refresh)
    assertRun('rejected', rejected, ['Rejected', 'Reused', 'Reused', 'Reused', 'Reused', 'Reused'])
    assert.deepEqual(Option.getOrThrow(yield* DataGraph.getHead(key)), afterConfirm)
    const rejectedAgain = yield* DataGraph.materialize(target, refresh)
    assertRun('rejected-again', rejectedAgain, [
      'Rejected',
      'Reused',
      'Reused',
      'Reused',
      'Reused',
      'Reused',
    ])
    const firstAttempt = rejected.trace[0]?.outcome
    const secondAttempt = rejectedAgain.trace[0]?.outcome
    assert.ok(firstAttempt?._tag === 'Rejected' && secondAttempt?._tag === 'Rejected')
    assert.notEqual(firstAttempt.attempt.digest, secondAttempt.attempt.digest)
    const store = yield* GraphStore
    assert.ok(
      Option.isNone(
        yield* store.lookup(
          `data-graph/actions/${afterConfirm.action.digest.slice('sha256:'.length)}`,
        ),
      ),
    )
    let attemptCount = 0
    for (const shard of yield* fs.readDirectory(`${root}/sha256`)) {
      for (const object of yield* fs.readDirectory(`${root}/sha256/${shard}`)) {
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          yield* fs.readFileString(`${root}/sha256/${shard}/${object}`),
        ).pipe(Effect.result)
        if (
          decoded._tag === 'Success' &&
          decoded.success !== null &&
          typeof decoded.success === 'object' &&
          !Array.isArray(decoded.success) &&
          'role' in decoded.success &&
          decoded.success.role === 'data-graph.attempt'
        )
          attemptCount++
      }
    }
    assert.equal(attemptCount, 3)
    assert.equal(calls['source-document'], 8)
    const selected = yield* DataGraph.materialize(target)
    assertRun('selected-after-rejection', selected, reused)
    assert.equal(selected.output.digest, changed.output.digest)
    assert.deepEqual(calls, {
      'source-document': 8,
      extract: 4,
      'render-en': 2,
      gate: 2,
      'render-de': 2,
      bundle: 3,
    })
    lines.push(
      `executor calls: ${Object.entries(calls)
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}`,
    )
    lines.push('assertions=passed; real CAS temporary directory cleaned on scope close')
    return lines
  }).pipe(Effect.provide(GraphStore.fileSystem(root)))
})
