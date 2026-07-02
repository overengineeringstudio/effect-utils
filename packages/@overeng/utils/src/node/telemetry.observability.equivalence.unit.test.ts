/**
 * Property-based encoder-equivalence proof for the `pw.*` + `cmd.*` telemetry migration (SC-R14).
 *
 * The migration re-points the playwright helpers' + command runner's runtime spans/annotations at
 * DERIVED encoders from the registered seam contracts (`./playwright/pw.contract.ts`,
 * `./cmd.contract.ts`). This test proves "no runtime behavior lost": for every migrated operation,
 * every annotate-only bundle, AND the two dynamic-name-bridge encoders (rebuilt from the SAME
 * catalog schemas the runtime uses), the DERIVED product surface (`.operation.encodeSync` /
 * `OtelAttrs.encodeSync`) produces byte-identical attribute maps to an INDEPENDENT, hand-authored
 * baseline (inline `OtelAttr.*` + `OtelOperation.define` / `OtelAttrs.defineSync`, mirroring the
 * pre-migration source) — over `Schema` arbitraries exercising optional-present / optional-absent
 * branches and derived span labels.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contracts), so the comparison is real and not vacuous.
 *
 * Arbitrary constraints mirror the notion-md/megarepo equivalence tests: string attrs use
 * `Schema.NonEmptyTrimmedString` (a derived span label read from an attribute must not be
 * empty/whitespace → throws on both sides); numeric attrs use `Schema.NonNegativeInt` (raw
 * `Schema.Number` would generate `NaN`/`±Infinity`, rejected by both encoders → noise).
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

import { CmdCollectOperation, CmdLoggingOperation, CmdRunOperation } from './cmd.contract.ts'
import {
  PwContextAttrs,
  PwExpectAttrs,
  PwLocatorAttrs,
  PwOp,
  PwPageAttrs,
  PwStep,
  PwStepName,
  PwStepParentSpanTag,
  PwTryAttrs,
  PwWaitAttemptAttrs,
  PwWaitOperation,
} from './playwright/pw.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Flag = Schema.Boolean
const Count = Schema.NonNegativeInt

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const b = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))
const jsonArr = (key: string) =>
  Schema.Array(Schema.String).pipe(OtelAttr.key({ key, encode: 'json' }))

// ---- independent hand-authored operation baselines (mirror pre-migration source) ----
const cmdRunBaseline = OtelOperation.define({
  name: 'cmd.run',
  schema: Schema.Struct({
    label: label(),
    cwd: s('cmd.cwd'),
    command: s('cmd.command'),
    args: jsonArr('cmd.args'),
    logDir: Schema.optional(s('cmd.log_dir')),
    shell: b('cmd.shell'),
  }),
  label: ({ label }) => label,
})
const cmdCollectBaseline = OtelOperation.define({
  name: 'cmd.collect',
  schema: Schema.Struct({
    label: label(),
    cwd: Schema.optional(s('cmd.cwd')),
    shell: b('cmd.shell'),
  }),
  label: ({ label }) => label,
})
const cmdLoggingBaseline = OtelOperation.define({
  name: 'cmd.run-with-logging',
  schema: Schema.Struct({
    label: label(),
    cwd: s('cmd.cwd'),
    logPath: s('cmd.log_path'),
    shell: b('cmd.shell'),
  }),
  label: ({ label }) => label,
})
const pwWaitBaseline = OtelOperation.define({
  name: 'pw.wait.until',
  schema: Schema.Struct({
    label: label(),
    waitLabel: s('pw.wait.label'),
    pollInterval: s('pw.wait.pollInterval'),
    timeout: s('pw.wait.timeout'),
  }),
  label: ({ label }) => label,
})

// ---- per-operation cases (name / baseline / derived / input arbitrary) ----
const opCases = [
  {
    name: 'cmd.run',
    baseline: cmdRunBaseline,
    derived: CmdRunOperation.operation,
    input: Schema.Struct({
      label: Str,
      cwd: Str,
      command: Str,
      args: Schema.Array(Str),
      logDir: Schema.optional(Str),
      shell: Flag,
    }),
  },
  {
    name: 'cmd.collect',
    baseline: cmdCollectBaseline,
    derived: CmdCollectOperation.operation,
    input: Schema.Struct({ label: Str, cwd: Schema.optional(Str), shell: Flag }),
  },
  {
    name: 'cmd.run-with-logging',
    baseline: cmdLoggingBaseline,
    derived: CmdLoggingOperation.operation,
    input: Schema.Struct({ label: Str, cwd: Str, logPath: Str, shell: Flag }),
  },
  {
    name: 'pw.wait.until',
    baseline: pwWaitBaseline,
    derived: PwWaitOperation.operation,
    input: Schema.Struct({ label: Str, waitLabel: Str, pollInterval: Str, timeout: Str }),
  },
] as const

// ---- independent hand-authored annotate-bundle / dynamic-bridge baselines ----
const locatorBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    timeoutMs: Schema.optional(n('pw.timeout.ms')),
    valueLen: Schema.optional(n('pw.value.len')),
    textLen: Schema.optional(n('pw.text.len')),
    delayMs: Schema.optional(n('pw.delay.ms')),
    jitterMs: Schema.optional(n('pw.jitter.ms')),
    key: Schema.optional(s('pw.key')),
    selector: Schema.optional(s('pw.selector')),
    role: Schema.optional(s('pw.role')),
    name: Schema.optional(s('pw.name')),
    testId: Schema.optional(s('pw.testId')),
    text: Schema.optional(s('pw.text')),
    label: Schema.optional(s('pw.label')),
    placeholder: Schema.optional(s('pw.placeholder')),
  }),
)
const pageBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    url: Schema.optional(s('pw.url')),
    waitUntil: Schema.optional(s('pw.waitUntil')),
    loadState: Schema.optional(s('pw.loadState')),
    timeoutMs: Schema.optional(n('pw.timeout.ms')),
    urlMatch: Schema.optional(s('pw.urlMatch')),
    jitterMsMin: Schema.optional(n('pw.jitter.msMin')),
    jitterMsMax: Schema.optional(n('pw.jitter.msMax')),
    viewportWidth: Schema.optional(n('pw.viewport.width')),
    viewportHeight: Schema.optional(n('pw.viewport.height')),
    screenshotPath: Schema.optional(s('pw.screenshot.path')),
    screenshotFullPage: Schema.optional(b('pw.screenshot.fullPage')),
  }),
)
const contextBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    cookieCount: Schema.optional(n('pw.cookie.count')),
    cookiesUrl: Schema.optional(s('pw.cookies.url')),
    storageStatePath: Schema.optional(s('pw.storageState.path')),
  }),
)
const waitAttemptBaseline = OtelAttrs.defineSync(Schema.Struct({ attempt: n('pw.wait.attempt') }))
const tryBaseline = OtelAttrs.defineSync(Schema.Struct({ op: s('pw.try.op') }))
const expectBaseline = OtelAttrs.defineSync(Schema.Struct({ assertion: s('pw.expect.assertion') }))
// Dynamic-name bridges: their encoders are rebuilt from catalog schemas in op.ts / step.ts; the
// baseline reproduces that exact field plan (label dropped, keys inline) so the derived-from-catalog
// rebuild is proven byte-identical.
const opBridgeBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: OtelAttr.drop(Schema.NonEmptyString), op: s('pw.op') }),
)
const stepBridgeBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: OtelAttr.drop(Schema.NonEmptyString),
    step: b('pw.step'),
    stepName: s('pw.step.name'),
    parentSpanTag: Schema.optional(s('pw.step.parentSpan._tag')),
  }),
)

const bundleCases = [
  {
    name: 'PwLocatorAttrs',
    baseline: locatorBaseline,
    derived: PwLocatorAttrs,
    input: Schema.Struct({
      timeoutMs: Schema.optional(Count),
      valueLen: Schema.optional(Count),
      textLen: Schema.optional(Count),
      delayMs: Schema.optional(Count),
      jitterMs: Schema.optional(Count),
      key: Schema.optional(Str),
      selector: Schema.optional(Str),
      role: Schema.optional(Str),
      name: Schema.optional(Str),
      testId: Schema.optional(Str),
      text: Schema.optional(Str),
      label: Schema.optional(Str),
      placeholder: Schema.optional(Str),
    }),
  },
  {
    name: 'PwPageAttrs',
    baseline: pageBaseline,
    derived: PwPageAttrs,
    input: Schema.Struct({
      url: Schema.optional(Str),
      waitUntil: Schema.optional(Str),
      loadState: Schema.optional(Str),
      timeoutMs: Schema.optional(Count),
      urlMatch: Schema.optional(Str),
      jitterMsMin: Schema.optional(Count),
      jitterMsMax: Schema.optional(Count),
      viewportWidth: Schema.optional(Count),
      viewportHeight: Schema.optional(Count),
      screenshotPath: Schema.optional(Str),
      screenshotFullPage: Schema.optional(Flag),
    }),
  },
  {
    name: 'PwContextAttrs',
    baseline: contextBaseline,
    derived: PwContextAttrs,
    input: Schema.Struct({
      cookieCount: Schema.optional(Count),
      cookiesUrl: Schema.optional(Str),
      storageStatePath: Schema.optional(Str),
    }),
  },
  {
    name: 'PwWaitAttemptAttrs',
    baseline: waitAttemptBaseline,
    derived: PwWaitAttemptAttrs,
    input: Schema.Struct({ attempt: Count }),
  },
  {
    name: 'PwTryAttrs',
    baseline: tryBaseline,
    derived: PwTryAttrs,
    input: Schema.Struct({ op: Str }),
  },
  {
    name: 'PwExpectAttrs',
    baseline: expectBaseline,
    derived: PwExpectAttrs,
    input: Schema.Struct({ assertion: Str }),
  },
  {
    name: 'op-bridge (pw.op)',
    baseline: opBridgeBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ label: OtelAttr.drop(Schema.NonEmptyString), op: PwOp }),
    ),
    input: Schema.Struct({ label: Str, op: Str }),
  },
  {
    name: 'step-bridge (pw.step*)',
    baseline: stepBridgeBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: OtelAttr.drop(Schema.NonEmptyString),
        step: PwStep,
        stepName: PwStepName,
        parentSpanTag: Schema.optional(PwStepParentSpanTag),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      step: Flag,
      stepName: Str,
      parentSpanTag: Schema.optional(Str),
    }),
  },
] as const

describe('pw.* + cmd.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
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

describe('pw.* annotate/dynamic-bridge encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
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
