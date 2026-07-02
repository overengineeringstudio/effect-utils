/**
 * Property-based encoder-equivalence proof for the `ci_tools.*` telemetry migration (SC-R14).
 *
 * The migration re-points ci-tools' deploy spans at DERIVED encoders from the registered seam
 * contract (`./deploy-domain.contract.ts`). This test proves "no runtime behavior lost": for every
 * migrated static operation the DERIVED surface (`.operation.encodeSync`) produces byte-identical
 * attribute maps to an INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` +
 * `OtelOperation.define`, mirroring the pre-migration source — including each label extractor that
 * reads a catalog attribute directly, and the optional `run_id` / `error_kind` / `cleanup_id`
 * branches). All keys are already namespaced `ci_tools.deploy.*` (behavior-preserving; no renames).
 *
 * NOTE the migrated `DeployOperation` reports `metadata.root === false` where the pre-migration def
 * used `root: true`; that flag is a call-site concern (`.withRoot`) that does NOT affect `encodeSync`
 * output, and `DeployOperation` has no runtime call site — so the encoder equivalence below is the
 * full behavior contract.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelOperation, type OtelOperationDefinition } from '@overeng/otel-contract'

import {
  DeployAttemptOperation,
  DeployCleanupOperation,
  DeployOperation,
  DeployProviderOperation,
  DeployVerifyOperation,
} from './deploy-domain.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Count = Schema.NonNegativeInt
const Provider = Schema.Literal('netlify', 'vercel')
const Mode = Schema.Literal('prod', 'pr', 'draft', 'preview')
const Status = Schema.Literal('success', 'failure', 'skipped')
const CleanupStatus = Schema.Literal('succeeded', 'failed', 'skipped')

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))
const lit = <const V extends readonly [string, ...string[]]>(key: string, ...values: V) =>
  Schema.Literal(...values).pipe(OtelAttr.key({ key }))
const shortSpanLabel = (value: string) => value.slice(0, 40)

// ---- independent hand-authored operation baselines (mirror pre-migration source) ----
const deployBaseline = OtelOperation.define({
  name: 'ci-tools.deploy',
  root: true,
  schema: Schema.Struct({
    provider: lit('ci_tools.deploy.provider', 'netlify', 'vercel'),
    target: s('ci_tools.deploy.target'),
    mode: lit('ci_tools.deploy.mode', 'prod', 'pr', 'draft', 'preview'),
    runId: Schema.optional(s('ci_tools.deploy.run_id')),
  }),
  label: ({ target }) => shortSpanLabel(target),
})
const deployProviderBaseline = OtelOperation.define({
  name: 'ci-tools.deploy.provider',
  schema: Schema.Struct({
    provider: lit('ci_tools.deploy.provider', 'netlify', 'vercel'),
    target: s('ci_tools.deploy.target'),
  }),
  label: ({ provider }) => provider,
})
const deployAttemptBaseline = OtelOperation.define({
  name: 'ci-tools.deploy.attempt',
  schema: Schema.Struct({
    provider: lit('ci_tools.deploy.provider', 'netlify', 'vercel'),
    target: s('ci_tools.deploy.target'),
    mode: lit('ci_tools.deploy.mode', 'prod', 'pr', 'draft', 'preview'),
    attempt: n('ci_tools.deploy.attempt'),
    status: lit('ci_tools.deploy.status', 'success', 'failure', 'skipped'),
    errorKind: Schema.optional(s('ci_tools.deploy.error_kind')),
  }),
  label: ({ attempt }) => String(attempt),
})
const deployVerifyBaseline = OtelOperation.define({
  name: 'ci-tools.deploy.verify',
  schema: Schema.Struct({
    provider: lit('ci_tools.deploy.provider', 'netlify', 'vercel'),
    target: s('ci_tools.deploy.target'),
    status: lit('ci_tools.deploy.status', 'success', 'failure', 'skipped'),
    urlHost: s('ci_tools.deploy.url_host'),
    errorKind: Schema.optional(s('ci_tools.deploy.error_kind')),
  }),
  label: ({ urlHost }) => shortSpanLabel(urlHost),
})
const deployCleanupBaseline = OtelOperation.define({
  name: 'ci-tools.deploy.cleanup',
  schema: Schema.Struct({
    provider: lit('ci_tools.deploy.provider', 'netlify', 'vercel'),
    target: s('ci_tools.deploy.target'),
    cleanupId: Schema.optional(s('ci_tools.deploy.cleanup_id')),
    cleanupStatus: lit('ci_tools.deploy.cleanup_status', 'succeeded', 'failed', 'skipped'),
  }),
  label: ({ cleanupId, cleanupStatus }) => shortSpanLabel(cleanupId ?? cleanupStatus),
})

const opCases = [
  {
    name: 'ci-tools.deploy',
    baseline: deployBaseline,
    derived: DeployOperation,
    input: Schema.Struct({
      provider: Provider,
      target: Str,
      mode: Mode,
      runId: Schema.optional(Str),
    }),
  },
  {
    name: 'ci-tools.deploy.provider',
    baseline: deployProviderBaseline,
    derived: DeployProviderOperation,
    input: Schema.Struct({ provider: Provider, target: Str }),
  },
  {
    name: 'ci-tools.deploy.attempt',
    baseline: deployAttemptBaseline,
    derived: DeployAttemptOperation,
    input: Schema.Struct({
      provider: Provider,
      target: Str,
      mode: Mode,
      attempt: Count,
      status: Status,
      errorKind: Schema.optional(Str),
    }),
  },
  {
    name: 'ci-tools.deploy.verify',
    baseline: deployVerifyBaseline,
    derived: DeployVerifyOperation,
    input: Schema.Struct({
      provider: Provider,
      target: Str,
      status: Status,
      urlHost: Str,
      errorKind: Schema.optional(Str),
    }),
  },
  {
    name: 'ci-tools.deploy.cleanup',
    baseline: deployCleanupBaseline,
    derived: DeployCleanupOperation,
    input: Schema.Struct({
      provider: Provider,
      target: Str,
      cleanupId: Schema.optional(Str),
      cleanupStatus: CleanupStatus,
    }),
  },
] as const

describe('ci_tools.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
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
