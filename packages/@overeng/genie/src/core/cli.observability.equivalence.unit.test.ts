/**
 * Property-based encoder-equivalence proof for the `cli.*` telemetry migration (SC-R14).
 *
 * The migration re-points genie's runtime `cli.mode` bridge bundle (`observability.ts`
 * `cliModeAttrs`) at the DERIVED catalog schema from the registered seam contract
 * (`./cli.contract.ts`). This test proves "no runtime behavior lost": the bundle rebuilt from the
 * IMPORTED catalog schema (exactly as `observability.ts` does) produces byte-identical attribute
 * maps to an INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` + `OtelAttrs.defineSync`),
 * over `Schema` arbitraries.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the seam contract), so the comparison is real and not vacuous.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'

import { CliMode } from './cli.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))

// ---- independent hand-authored baseline (the `genie/<cliMode>` bridge bundle) ----
const cliModeBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), cliMode: s('cli.mode') }),
)

const bundleCases = [
  {
    name: 'cliModeAttrs',
    baseline: cliModeBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ label: label(), cliMode: CliMode })),
    input: Schema.Struct({ label: Str, cliMode: Str }),
  },
] as const

describe('cli.* derived bridge encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
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
