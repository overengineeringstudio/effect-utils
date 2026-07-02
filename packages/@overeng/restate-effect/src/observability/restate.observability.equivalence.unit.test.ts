/**
 * Property-based encoder-equivalence proof for the `restate.*` telemetry migration (SC-R14).
 *
 * The migration re-points restate-effect's runtime boundary attribute bundles at DERIVED catalog
 * schemas from the registered seam contract (`./restate.contract.ts`). This test proves "no runtime
 * behavior lost": for both boundary annotate bundles AND the dynamic-name `restateOperation` span,
 * the DERIVED product surface (`BoundaryAttemptAttrs`/`BoundaryOutcomeAttrs` `.encodeSync` /
 * `restateOperation(name).operation.encodeSync`) produces byte-identical attribute maps to an
 * INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` + `OtelAttrs.defineSync` /
 * `OtelOperation.define`, mirroring restate-effect's pre-migration `contract.ts`) — over `Schema`
 * arbitraries exercising optional-present / optional-absent branches and the derived span label.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the seam contract), so the comparison is real and not vacuous.
 *
 * NOTE: the replay-aware baseline metrics (`Metrics.ts`) are intentionally OUT of scope — their
 * label keys are unprefixed (`service`/`handler`/`outcome`/`step`/`name`) and routing them through
 * the registry `metric(...)` DSL would rename the emitted keys (a breaking wire change), so they
 * were deferred (see `./restate.contract.ts` docstring). Their encode is unchanged by this migration.
 *
 * Arbitrary constraints: string attrs use `Schema.NonEmptyTrimmedString` (a derived span label read
 * from an attribute must not be empty/whitespace → throws on both sides).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import { BoundaryAttemptAttrs, BoundaryOutcomeAttrs, restateOperation } from './contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const ErrorClass = Schema.Literal('terminal', 'retryable', 'cancelled')

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const boundedStr = (key: string) => OtelAttr.string({ key, metadata: { cardinality: 'bounded' } })
const highStr = (key: string) => OtelAttr.string({ key, metadata: { cardinality: 'high' } })

// ---- independent hand-authored baselines (mirror pre-migration contract.ts) ----

const boundaryAttemptBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    service: boundedStr('restate.service'),
    handler: boundedStr('restate.handler'),
    objectKey: Schema.optional(highStr('restate.object.key')),
    workflowId: Schema.optional(highStr('restate.workflow.id')),
    idempotencyKey: Schema.optional(highStr('restate.idempotency.key')),
  }),
)

const boundaryOutcomeBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    errorClass: Schema.optional(
      OtelAttr.literal('restate.error.class', 'terminal', 'retryable', 'cancelled'),
    ),
    errorTag: Schema.optional(boundedStr('restate.error.tag')),
  }),
)

const restateOperationBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({ label: OtelAttr.drop(Schema.NonEmptyString) }),
    label: ({ label }) => label,
  })

// ---- annotate-bundle cases (name / baseline / derived / input arbitrary) ----
const bundleCases = [
  {
    name: 'BoundaryAttemptAttrs',
    baseline: boundaryAttemptBaseline,
    derived: BoundaryAttemptAttrs,
    input: Schema.Struct({
      service: Str,
      handler: Str,
      objectKey: Schema.optional(Str),
      workflowId: Schema.optional(Str),
      idempotencyKey: Schema.optional(Str),
    }),
  },
  {
    name: 'BoundaryOutcomeAttrs',
    baseline: boundaryOutcomeBaseline,
    derived: BoundaryOutcomeAttrs,
    input: Schema.Struct({
      errorClass: Schema.optional(ErrorClass),
      errorTag: Schema.optional(Str),
    }),
  },
] as const

describe('restate.* derived annotate encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of bundleCases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = c.baseline.encodeSync(value as never)
        const derived = c.derived.encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on attribute keys`, () => {
      expect([...c.derived.keys].toSorted()).toStrictEqual([...c.baseline.keys].toSorted())
    })
  }
})

describe('restate.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  const OP_NAME = 'restate.dynamic-op'
  const baseline = restateOperationBaseline(OP_NAME)
  const derived = restateOperation(OP_NAME)

  it.prop(
    'restateOperation: derived .operation.encodeSync ≡ baseline.encodeSync',
    [Schema.Struct({ label: Str })],
    ([value]) => {
      const b = (baseline as OtelOperationDefinition<never>).encodeSync(value as never)
      const d = (derived as OtelOperationDefinition<never>).encodeSync(value as never)
      expect(d).toStrictEqual(b)
      expect(typeof d['span.label']).toBe('string')
    },
    { fastCheck: { numRuns: 200 } },
  )

  it('restateOperation: derived and baseline agree on span name + attribute keys', () => {
    expect(derived.metadata.name).toBe(baseline.metadata.name)
    expect([...derived.metadata.attributeKeys].toSorted()).toStrictEqual(
      [...baseline.metadata.attributeKeys].toSorted(),
    )
  })
})
