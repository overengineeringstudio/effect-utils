/**
 * Property-based encoder-equivalence proof for the `pty.*` telemetry migration (SC-R14).
 *
 * The migration re-points pty-effect's runtime spans at DERIVED encoders from the registered seam
 * contract (`./pty.contract.ts`). This test proves "no runtime behavior lost": for the migrated
 * static operation (`pty-session.make`) AND the two dynamic-name-bridge encoders rebuilt in
 * `client.ts` from the SAME catalog schemas (`withPtyNameSpan` / `withPtyWaitSpan`), the DERIVED
 * surface produces byte-identical attribute maps to an INDEPENDENT, hand-authored baseline (inline
 * `OtelAttr.*` + `OtelOperation.define`, mirroring the pre-migration source).
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contract), so the comparison is real and not vacuous. All keys are already namespaced
 * `pty.*` (behavior-preserving; no renames). String attrs use `NonEmptyTrimmedString` (derived span
 * labels must not be empty/whitespace).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelOperation, type OtelOperationDefinition } from '@overeng/otel-contract'

import { PtyName, PtySessionMakeOperation, PtyWaitNeedle } from './pty.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Mode = Schema.Literal('Spawn', 'Server')

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const drop = () => OtelAttr.drop(Schema.NonEmptyString)
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))

// ---- independent hand-authored baselines (mirror pre-migration source) ----
const sessionMakeBaseline = OtelOperation.define({
  name: 'pty-session.make',
  schema: Schema.Struct({
    label: drop(),
    mode: Schema.Literal('Spawn', 'Server').pipe(OtelAttr.key({ key: 'pty.session.mode' })),
  }),
  label: ({ label }) => label,
})
// Dynamic-name bridges: their encoders are rebuilt from catalog schemas in `client.ts`; the baseline
// reproduces that exact field plan (label dropped, keys inline) at a representative fixed span name.
const nameBridgeBaseline = OtelOperation.define({
  name: 'pty-client.spawnDaemon',
  schema: Schema.Struct({ label: drop(), name: s('pty.name') }),
  label: ({ label }) => label,
})
const waitBridgeBaseline = OtelOperation.define({
  name: 'pty-client.waitForText',
  schema: Schema.Struct({ label: drop(), name: s('pty.name'), needle: s('pty.wait.needle') }),
  label: ({ label }) => label,
})

const opCases = [
  {
    name: 'pty-session.make',
    baseline: sessionMakeBaseline,
    derived: PtySessionMakeOperation.operation,
    input: Schema.Struct({ label: Str, mode: Mode }),
  },
  {
    name: 'pty-client name-bridge (pty.name)',
    baseline: nameBridgeBaseline,
    derived: OtelOperation.define({
      name: 'pty-client.spawnDaemon',
      schema: Schema.Struct({ label: drop(), name: PtyName }),
      label: ({ label }) => label,
    }),
    input: Schema.Struct({ label: Str, name: Str }),
  },
  {
    name: 'pty-client wait-bridge (pty.name + pty.wait.needle)',
    baseline: waitBridgeBaseline,
    derived: OtelOperation.define({
      name: 'pty-client.waitForText',
      schema: Schema.Struct({ label: drop(), name: PtyName, needle: PtyWaitNeedle }),
      label: ({ label }) => label,
    }),
    input: Schema.Struct({ label: Str, name: Str, needle: Str }),
  },
] as const

describe('pty.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of opCases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
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
