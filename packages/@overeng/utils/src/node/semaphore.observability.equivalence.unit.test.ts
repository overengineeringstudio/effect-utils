/**
 * Property-based encoder-equivalence proof for the `semaphore.*` telemetry migration (SC-R14).
 *
 * The migration re-points `file-system-backing.ts`' runtime spans at DERIVED encoders from the
 * registered seam contract (`./semaphore.contract.ts`). This test proves "no runtime behavior lost":
 * for both migrated operations the DERIVED surface (`.operation.encodeSync`) produces byte-identical
 * attribute maps to an INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` +
 * `OtelOperation.define`, mirroring the pre-migration source). All keys are already namespaced
 * `semaphore.*` (behavior-preserving; no renames).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelOperation, type OtelOperationDefinition } from '@overeng/otel-contract'

import { SemaphoreForceRevokeOperation, SemaphoreKeyOperation } from './semaphore.contract.ts'

const Str = Schema.NonEmptyTrimmedString
const drop = () => OtelAttr.drop(Schema.NonEmptyString)
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))

const keyBaseline = OtelOperation.define({
  name: 'FileSystemBacking.semaphore.key',
  schema: Schema.Struct({ label: drop(), key: s('semaphore.key') }),
  label: ({ label }) => label,
})
const forceRevokeBaseline = OtelOperation.define({
  name: 'FileSystemBacking.semaphore.forceRevoke',
  schema: Schema.Struct({
    label: drop(),
    key: s('semaphore.key'),
    targetHolderId: s('semaphore.target_holder_id'),
  }),
  label: ({ label }) => label,
})

const opCases = [
  {
    name: 'FileSystemBacking.semaphore.key',
    baseline: keyBaseline,
    derived: SemaphoreKeyOperation.operation,
    input: Schema.Struct({ label: Str, key: Str }),
  },
  {
    name: 'FileSystemBacking.semaphore.forceRevoke',
    baseline: forceRevokeBaseline,
    derived: SemaphoreForceRevokeOperation.operation,
    input: Schema.Struct({ label: Str, key: Str, targetHolderId: Str }),
  },
] as const

describe('semaphore.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of opCases) {
    it.prop(
      `${c.name}: derived .operation.encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = (c.baseline as OtelOperationDefinition<never>).encodeSync(value as never)
        const derived = (c.derived as OtelOperationDefinition<never>).encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
        expect(typeof derived['span.label']).toBe('string')
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on span name + attribute keys`, () => {
      expect(c.derived.metadata.name).toBe(c.baseline.metadata.name)
      expect([...c.derived.metadata.attributeKeys].toSorted()).toStrictEqual(
        [...c.baseline.metadata.attributeKeys].toSorted(),
      )
    })
  }
})
