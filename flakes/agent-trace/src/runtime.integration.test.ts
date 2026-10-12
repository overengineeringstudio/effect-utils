import { composeRegistry } from '@schickling/schema-registry'
import { Arbitrary, Effect, Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { authority, runtimeAuthority } from './registry.ts'
import { ArtifactFacts, captureArtifact } from './runtime.ts'
import { AgentTraceRuntimeV1, AgentTraceV2, auditAnnotations, strict } from './schema.ts'

const runtimeCodec = Schema.fromJsonString(AgentTraceRuntimeV1)
const artifactCodec = Schema.fromJsonString(AgentTraceV2)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const activeRuntime = Schema.Struct({
  ...AgentTraceRuntimeV1.fields,
  why: AgentTraceV2.fields.why,
})
const captureRequest = Schema.Struct({ runtime: activeRuntime, facts: ArtifactFacts })
const runtime = Schema.decodeSync(
  AgentTraceRuntimeV1,
  strict,
)({
  type: 'agent-trace-runtime/v1',
  who: { agent: 'agent/dotfiles/ci', principal: 'schickling' },
  why: { step: { name: 'compare', run: 'fedcba9876543210fedcba9876543210' } },
  how: {
    harness: { tool: 'OMP', version: '18.6.0' },
    model: { route: 'anthropic/claude-opus-5-5', effort: 'medium' },
    issuance: {
      _tag: 'st-issued',
      step_run: 'step-run/fedcba9876543210fedcba9876543210/compare',
    },
  },
  where: { session: 'dev3.01a14e79', host: 'dev3' },
})
const facts = Schema.decodeSync(
  ArtifactFacts,
  strict,
)({ id: 'event-1', at: '2026-10-10T00:00:00Z', artifact: 'commit:runtime-test' })
const rejectRuntime = (value: unknown): void => {
  expect(() => Schema.decodeUnknownSync(AgentTraceRuntimeV1, strict)(value)).toThrow()
  expect(() => Schema.decodeSync(runtimeCodec, strict)(json(value))).toThrow()
}

describe('Agent Trace runtime authority', () => {
  it('composes separate event and runtime authorities with audited shared facts', () => {
    auditAnnotations(AgentTraceRuntimeV1.ast)
    const registry = composeRegistry({ authorities: [authority, runtimeAuthority] })
    if (Result.isFailure(registry)) throw registry.failure
    expect(registry.success.fragments.map(({ id }) => id)).toEqual([
      'agent-trace/v2',
      'agent-trace-runtime/v1',
    ])
  })
  it('round-trips runtime JSON over 1000 semantic records', async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        Arbitrary.schema(AgentTraceRuntimeV1),
        (record) => {
          const wire = Schema.encodeSync(runtimeCodec, strict)(record)
          const decoded = Schema.decodeSync(runtimeCodec, strict)(wire)
          // Arbitrary emits null-prototype structs; JSON preserves data, not prototypes.
          expect(decoded).toEqual(record)
          return (
            Schema.encodeSync(runtimeCodec, strict)(decoded) === wire &&
            !('id' in decoded) &&
            !('at' in decoded) &&
            !('artifact' in decoded)
          )
        },
        { runs: 1000, seed: 18474, maxDiscards: 200000 },
      ),
    )
    expect(result).toMatchObject({ _tag: 'Passed', runs: 1000 })
  })

  it('captures exactly the active runtime and artifact facts over 1000 semantic records', async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        Arbitrary.schema(captureRequest),
        ({ runtime: record, facts: eventFacts }) => {
          const runtimeWire = Schema.encodeSync(runtimeCodec, strict)(record)
          const factsWire = Schema.encodeSync(
            Schema.fromJsonString(ArtifactFacts),
            strict,
          )(eventFacts)
          const captured = captureArtifact({ runtime: record, facts: eventFacts })
          const expected = {
            type: 'agent-trace/v2',
            ...eventFacts,
            who: record.who,
            why: record.why,
            how: record.how,
            where: record.where,
          }
          const artifactWire = Schema.encodeSync(artifactCodec, strict)(captured)
          expect(captured).toEqual(expected)
          expect(Schema.decodeSync(artifactCodec, strict)(artifactWire)).toEqual(expected)
          return (
            Schema.encodeSync(runtimeCodec, strict)(record) === runtimeWire &&
            Schema.encodeSync(Schema.fromJsonString(ArtifactFacts), strict)(eventFacts) ===
              factsWire
          )
        },
        { runs: 1000, seed: 18475, maxDiscards: 200000 },
      ),
    )
    expect(result).toMatchObject({ _tag: 'Passed', runs: 1000 })
  })

  it('accepts an old idle runtime with no purpose or optional issuance, without inventing a purpose', () => {
    const idle = Schema.decodeSync(
      AgentTraceRuntimeV1,
      strict,
    )({
      type: runtime.type,
      who: runtime.who,
      how: { harness: runtime.how.harness, model: runtime.how.model },
      where: runtime.where,
    })
    const wire = Schema.encodeSync(runtimeCodec, strict)(idle)
    expect(Schema.decodeSync(runtimeCodec, strict)(wire)).toEqual(idle)
    expect(idle).not.toHaveProperty('why')
    expect(idle.how).not.toHaveProperty('issuance')
    expect(() => captureArtifact({ runtime: idle, facts })).toThrow()
    expect(idle).not.toHaveProperty('why')
  })

  it.each([
    { _tag: 'st-issued' },
    { _tag: 'st-issued', step_run: 'step-run/not-a-run/compare' },
    { _tag: 'st-issued', step_run: 'step-run/FEDCBA9876543210FEDCBA9876543210/compare' },
    { _tag: 'st-issued', step_run: 'step-run/fedcba9876543210fedcba9876543210/' },
    { _tag: 'st-issued', step_run: 'step-run/fedcba9876543210fedcba9876543210/Compare' },
    {
      _tag: 'st-issued',
      step_run: 'step-run/fedcba9876543210fedcba9876543210/compare',
      launcher: 'omp',
    },
    { _tag: 'not-st-issued' },
    { _tag: 'not-st-issued', launcher: '' },
    { _tag: 'not-st-issued', launcher: ' omp ' },
    { _tag: 'not-st-issued', launcher: 'omp\nother' },
    {
      _tag: 'not-st-issued',
      launcher: 'omp',
      step_run: 'step-run/fedcba9876543210fedcba9876543210/compare',
    },
    { _tag: 'unknown', launcher: 'omp' },
    null,
    'st-issued',
  ])('rejects malformed issuance %#', (issuance) => {
    rejectRuntime({ ...runtime, how: { ...runtime.how, issuance } })
  })

  it.each([{}, null])('rejects an empty or null purpose %#', (why) => {
    rejectRuntime({ ...runtime, why })
  })

  it.each([
    { field: 'id', value: facts.id },
    { field: 'at', value: facts.at },
    { field: 'artifact', value: facts.artifact },
  ])('rejects the event-envelope field $field on a runtime', ({ field, value }) => {
    const envelope = { ...runtime, [field]: value }
    rejectRuntime(envelope)
    expect(() => captureArtifact({ runtime: envelope, facts })).toThrow()
  })

  it.each([
    undefined,
    null,
    {},
    { at: facts.at, artifact: facts.artifact },
    { id: facts.id, artifact: facts.artifact },
    { id: facts.id, at: facts.at },
    { ...facts, id: '' },
    { ...facts, id: 1 },
    { ...facts, at: '2026-10-10' },
    { ...facts, at: '2026-10-10T00:00:00+01:00' },
    { ...facts, artifact: '' },
    { ...facts, artifact: null },
    { ...facts, artifact: 'commit:one\ncommit:two' },
    { ...facts, extra: 'not-an-artifact-fact' },
  ])('rejects absent or malformed artifact facts at capture %#', (eventFacts) => {
    expect(() => Schema.decodeUnknownSync(ArtifactFacts, strict)(eventFacts)).toThrow()
    // Reflect exercises untyped producer input without weakening the typed capture API.
    expect(() =>
      Reflect.apply(captureArtifact, undefined, [{ runtime, facts: eventFacts }]),
    ).toThrow()
  })

  it('requires the facts argument even for a valid active runtime', () => {
    expect(() => Reflect.apply(captureArtifact, undefined, [{ runtime }])).toThrow()
  })
})
