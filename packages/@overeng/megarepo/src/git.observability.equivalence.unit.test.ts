/**
 * Property-based encoder-equivalence proof for the `git.*` telemetry migration (SC-R14).
 *
 * The migration re-points megarepo's runtime git bridge/annotate bundles (`lib/observability.ts`)
 * at the DERIVED catalog schemas from the registered seam contract (`./git.contract.ts`). This test
 * proves "no runtime behavior lost": each bundle rebuilt from the IMPORTED catalog schemas (exactly
 * as `observability.ts` does) produces byte-identical attribute maps to an INDEPENDENT, hand-authored
 * baseline (inline `OtelAttr.*` + `OtelAttrs.defineSync`), over `Schema` arbitraries exercising
 * optional-present / optional-absent branches and the derived span label.
 *
 * The baselines are authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the seam contract), so the comparison is real and not vacuous. Numeric attrs use
 * `NonNegativeInt` (the catalog keys are `weaverType: 'int'`).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'

import {
  GitBare,
  GitBranch,
  GitCommit,
  GitOutputBytes,
  GitOutputLines,
  GitStreamed,
  GitSubcommand,
  GitTimeoutMs,
  GitUrl,
} from './git.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Flag = Schema.Boolean
const Count = Schema.NonNegativeInt

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const b = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))

// ---- independent hand-authored baselines (the git bridge/annotate bundles) ----
const gitUrlBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), url: s('git.url'), bare: Schema.optional(b('git.bare')) }),
)
const gitCmdBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    subcommand: s('git.subcommand'),
    streamed: b('git.streamed'),
    timeoutMs: Schema.optional(n('git.timeout_ms')),
  }),
)
const gitCmdOutputBaseline = OtelAttrs.defineSync(
  Schema.Struct({ outputBytes: n('git.output.bytes'), outputLines: n('git.output.lines') }),
)
const gitBranchBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), branch: s('git.branch') }),
)
const gitCommitBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), commit: s('git.commit') }),
)

const bundleCases = [
  {
    name: 'gitUrlAttrs',
    baseline: gitUrlBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ label: label(), url: GitUrl, bare: Schema.optional(GitBare) }),
    ),
    input: Schema.Struct({ label: Str, url: Str, bare: Schema.optional(Flag) }),
  },
  {
    name: 'gitCmdAttrs',
    baseline: gitCmdBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        subcommand: GitSubcommand,
        streamed: GitStreamed,
        timeoutMs: Schema.optional(GitTimeoutMs),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      subcommand: Str,
      streamed: Flag,
      timeoutMs: Schema.optional(Count),
    }),
  },
  {
    name: 'gitCmdOutputAttrs',
    baseline: gitCmdOutputBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ outputBytes: GitOutputBytes, outputLines: GitOutputLines }),
    ),
    input: Schema.Struct({ outputBytes: Count, outputLines: Count }),
  },
  {
    name: 'gitBranchAttrs',
    baseline: gitBranchBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ label: label(), branch: GitBranch })),
    input: Schema.Struct({ label: Str, branch: Str }),
  },
  {
    name: 'gitCommitAttrs',
    baseline: gitCommitBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ label: label(), commit: GitCommit })),
    input: Schema.Struct({ label: Str, commit: Str }),
  },
] as const

describe('git.* derived bridge encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
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
