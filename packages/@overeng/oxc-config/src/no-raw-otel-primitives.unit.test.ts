import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { RuleTester as ESLintRuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const ruleTester = new ESLintRuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

const rule = plugin.rules['no-raw-otel-primitives']

/** The exact rendered message for a flagged `Effect.withSpan`. */
const effectWithSpanMessage =
  'Raw OTEL primitive `Effect.withSpan()` bypasses the schema-first telemetry contract. Define an `OtelOperation`/`OtelSpan`/`OtelMetric` contract in package observability code and use that instead.'

ruleTester.run('no-raw-otel-primitives: valid contract usage and unrelated calls', rule, {
  valid: [
    {
      code: `import { Effect } from 'effect'
const value = Effect.gen(function* () { return 1 })`,
    },
    {
      code: `import { Stream } from 'effect'
const value = Stream.map(stream, (x) => x)`,
    },
    {
      code: `import { Effect } from 'other'
const value = Effect.withSpan('not-effect')`,
    },
    {
      code: `const Effect = { withSpan: () => undefined }
Effect.withSpan('local')`,
    },
    {
      code: `import { OtelOperation } from '@overeng/otel-contract'
const Operation = OtelOperation.define({ name: 'x', schema, label: () => 'x' })
effect.pipe(Operation.with({ label: 'x' }))`,
    },
    {
      code: `import { OtelMetric } from '@overeng/otel-contract'
const Invocations = OtelMetric.counter({ name: 'invocations_total', labels })`,
    },
  ],
  invalid: [],
})

ruleTester.run('no-raw-otel-primitives: invalid named imports', rule, {
  valid: [],
  invalid: [
    {
      code: `import { Effect } from 'effect'
const program = effect.pipe(Effect.withSpan('raw'))`,
      errors: [{ message: effectWithSpanMessage }],
    },
    {
      code: `import { Effect } from 'effect'
const program = Effect.annotateCurrentSpan('span.label', 'raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Stream } from 'effect'
const program = stream.pipe(Stream.withSpan('raw'))`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
  ],
})

ruleTester.run('no-raw-otel-primitives: invalid aliases and namespace imports', rule, {
  valid: [],
  invalid: [
    {
      code: `import { Effect as E } from 'effect'
const program = E.withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Stream as S } from 'effect'
const program = S.withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import * as EffectLib from 'effect'
const program = EffectLib.Effect.withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import * as EffectLib from 'effect'
const program = EffectLib.Stream.withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import * as EffectLib from 'effect'
const program = EffectLib.Effect.annotateCurrentSpan('span.label', 'raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import * as EffectLib from 'effect'
const metric = EffectLib.Metric.counter('raw_total')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
  ],
})

ruleTester.run('no-raw-otel-primitives: invalid direct raw imports', rule, {
  valid: [],
  invalid: [
    {
      code: `import { withSpan } from 'effect'
const program = withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { withSpan as rawWithSpan } from 'effect'
const program = rawWithSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { annotateCurrentSpan as annotate } from 'effect'
annotate('span.label', 'raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { counter } from 'effect'
const metric = counter('raw_total')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
  ],
})

ruleTester.run('no-raw-otel-primitives: invalid raw Metric APIs', rule, {
  valid: [],
  invalid: [
    {
      code: `import { Metric } from 'effect'
const metric = Metric.counter('raw_total')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Metric as M } from 'effect'
const metric = M.histogram('raw_ms', boundaries)`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Metric } from 'effect'
const tagged = Metric.tagged(metric, 'service', 'api')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Metric } from 'effect'
const program = Metric.increment(metric)`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Metric } from 'effect'
const program = Metric.incrementBy(metric, 2)`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
    {
      code: `import { Metric } from 'effect'
const program = Metric.update(metric, 42)`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
  ],
})

tsRuleTester.run('no-raw-otel-primitives: TypeScript', rule, {
  valid: [
    {
      code: `import { Effect } from 'effect'
const program: Effect.Effect<number> = Effect.succeed(1)`,
    },
    {
      code: `import type { Effect } from 'effect'
type Program = Effect.Effect<void>`,
    },
  ],
  invalid: [
    {
      code: `import { Effect as E } from 'effect'
const program = E.withSpan('raw')`,
      errors: [{ messageId: 'rawOtelPrimitive' }],
    },
  ],
})
