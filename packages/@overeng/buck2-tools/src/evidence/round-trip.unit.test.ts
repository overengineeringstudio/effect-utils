/**
 * OTelite-local round-trip suite for the Buck evidence lane.
 *
 * Runs the real projection through `OteliteTestHarness.runInProcessAllSignals`
 * — an in-process ephemeral OTLP receiver (the lane's authoritative local
 * capture path) — and asserts the trace/metric contract via
 * `expectTrace`/`expectMetrics`. Synthetic fixture evidence only: no real
 * buck2 run happens in unit tests (that is the E2E lane's job).
 *
 * Covered here:
 * - success trace shape: exactly-one CLIENT `buck.invocation` parented under
 *   the harness root + import-span LINK over W3C ids (R02/R04/R05)
 * - failure trace: error status preserved through the direct path (R03)
 * - malformed evidence: NO_VERDICT + zero rich spans (R03/R11)
 * - dead-exporter negative controls: recorded Buck result untouched (R08)
 * - metric cardinality guard scanned across ALL rows (R06)
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer, Ref } from 'effect'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import * as Otlp from '@effect/opentelemetry/Otlp'
import { FetchHttpClient } from '@effect/platform'
import { captureTest } from '@overeng/utils-dev/otelite'

import {
  decodeEvidence,
  expectExactlyOneInvocation,
  expectNoRichSpans,
  guardMetricCardinality,
  projectInvocation,
  readSpanLinksFromCapture,
  resultClassFor,
  verdictFor,
} from './mod.ts'
import { SpanAttrKeys, SpanNames } from './telemetry.ts'

const SERVICE = 'effect-utils-buck2'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const fixtureDigest = (): string => {
  const report = JSON.parse(fixture('build-report-success.json')) as {
    targets?: Record<string, { outputs?: Array<{ digest_sha256?: string }> }>
  }
  return report.targets?.['//apps/demo:bin']?.outputs?.[0]?.digest_sha256 ?? ''
}

const observationFor = (
  evidence: Parameters<typeof projectInvocation>[0]['evidence'],
  overrides: Partial<Parameters<typeof projectInvocation>[0]> = {},
): Parameters<typeof projectInvocation>[0] => ({
  argv: ['build', '--event-log', '/home/dev/effect-utils/run/current/events.log', '//apps/demo:bin'],
  buildReportPath: '/home/dev/effect-utils/run/current/report.json',
  durationMs: 1234,
  env: { SECRET_TOKEN: 'hunter2', PATH: '/usr/bin' },
  eventLogPath: '/home/dev/effect-utils/run/current/events.log',
  evidence,
  operationKind: 'build',
  platformClass: 'linux-x64',
  verdict: verdictFor({ evidence }),
  workspaceRoot: '/home/dev/effect-utils',
  ...overrides,
})

const successEvidence = () =>
  decodeEvidence({
    buildReportText: fixture('build-report-success.json'),
    eventLogText: fixture('event-log-v2026-04-15-success.jsonl'),
  })

describe('buck2 evidence — otelite round-trip', () => {
  it.scopedLive(
    'success shape: exactly one CLIENT invocation span under the harness root + import LINK',
    () =>
      Effect.gen(function* () {
        const otel = yield* captureTest({
          serviceName: SERVICE,
          rootSpanName: `${SERVICE}.root`,
          exportInterval: 50,
        })
        const { metrics, trace } = yield* otel.runInProcessAllSignals(
          projectInvocation(observationFor(successEvidence())),
        )

        // --- Exactly one buck.invocation CLIENT span under the harness root. ---
        const root = trace.expectOne({ name: `${SERVICE}.root` })
        const rootSpanId = root.span_id
        if (rootSpanId === null) throw new Error('harness root span missing span_id')
        const invocation = expectExactlyOneInvocation({ trace, options: { parentSpanId: rootSpanId } })
        expect(invocation.status_code).toBe(1) // STATUS_CODE_OK
        expect(invocation.attrs[SpanAttrKeys.platformClass]).toBe('linux-x64')
        expect(invocation.attrs[SpanAttrKeys.commandKind]).toBe('build')
        expect(invocation.attrs[SpanAttrKeys.invocationId]).toBe('inv-3f9a2c7')
        // Invocation ID is a correlation attribute — it must never be a trace id.
        expect(invocation.trace_id).not.toBe('inv-3f9a2c7')

        // --- Sanitized export (R07): no raw host paths, no env values survive. ---
        expect(invocation.attrs[SpanAttrKeys.buildReportPath]).toBe('run/current/report.json')
        expect(JSON.stringify(invocation)).not.toContain('hunter2')
        // No host prefix, no home dir, no raw path survives.
        expect(JSON.stringify(invocation)).not.toContain('/home/dev')
        expect(JSON.stringify(invocation)).not.toContain('events.log=')

        // --- Rich tier produced action + materialization spans. ---
        expect(trace.expectSome({ name: SpanNames.action })).toHaveLength(2)
        trace.expectSome({
          name: 'buck.artifact.materialized',
          attrs: { [SpanAttrKeys.digest]: fixtureDigest() },
        })

        // --- Independent import span LINKS to the invocation (W3C ids). ---
        const importSpan = trace.expectOne({ name: SpanNames.import })
        const links = readSpanLinksFromCapture(
          readFileSync(`${otel.capture.outDir}/traces.ndjson`, 'utf8'),
        ).filter((link) => link.spanName === SpanNames.import)
        expect(links).toHaveLength(1)
        expect(links[0]?.linkTraceId).toBe(importSpan.trace_id)
        expect(links[0]?.linkSpanId).toBe(invocation.span_id)

        // --- Metrics carry exactly the bounded labels (R06). ---
        guardMetricCardinality(metrics.metrics)
        metrics.expectOne({
          name: 'buck2_invocations_total',
          attrs: {
            'cache-class': 'partial',
            'operation-kind': 'build',
            'platform-class': 'linux-x64',
            'result-class': 'success',
          },
        })
      }),
    30_000,
  )

  it.scopedLive('failure trace preserves error status through the direct path', () =>
    Effect.gen(function* () {
      const otel = yield* captureTest({ serviceName: SERVICE, exportInterval: 50 })
      const failureEvidence = decodeEvidence({
        buildReportText: fixture('build-report-failure.json'),
        eventLogText: fixture('event-log-v2026-04-15-success.jsonl'),
      })
      const { metrics, trace } = yield* otel.runInProcessAllSignals(
        projectInvocation(observationFor(failureEvidence)),
      )

      // The failing Buck operation stays failing: ERROR status on the span.
      const invocation = trace.expectOne({ name: SpanNames.invocation })
      expect(invocation.status_code).toBe(2) // STATUS_CODE_ERROR
      expect(resultClassFor({ evidence: failureEvidence, verdict: verdictFor({ evidence: failureEvidence }) })).toBe('failure')
      expect(invocation.attrs[SpanAttrKeys.verdict]).toBe('FAIL')

      guardMetricCardinality(metrics.metrics)
      metrics.expectOne({
        name: 'buck2_invocations_total',
        attrs: { 'result-class': 'failure' },
      })
      // The import span still exists and mirrors the failing class.
      expect(trace.expectOne({ name: SpanNames.import }).attrs['import.result-class']).toBe(
        'failure',
      )
    }),
    30_000,
  )

  it.scopedLive('malformed evidence yields NO_VERDICT and zero rich spans', () =>
    Effect.gen(function* () {
      const otel = yield* captureTest({ serviceName: SERVICE, exportInterval: 50 })
      const malformed = decodeEvidence({
        buildReportText: '{"outcome":"SUCCESS"',
        eventLogText: 'not json at all',
      })
      const verdict = verdictFor({ evidence: malformed })
      expect(verdict).toStrictEqual({
        _tag: 'NO_VERDICT',
        cause: expect.stringMatching(/malformed/),
      })

      const { metrics, trace } = yield* otel.runInProcessAllSignals(
        projectInvocation(observationFor(malformed)),
      )

      // Invocation span exists but carries NO_VERDICT; rich spans absent.
      const invocation = trace.expectOne({ name: SpanNames.invocation })
      expect(invocation.attrs[SpanAttrKeys.verdict]).toBe('NO_VERDICT')
      expectNoRichSpans(trace)

      guardMetricCardinality(metrics.metrics)
      metrics.expectOne({
        name: 'buck2_invocations_total',
        attrs: { 'result-class': 'no-verdict' },
      })
    }),
    30_000,
  )

  it.scopedLive('dead exporter never changes the recorded Buck result (R08)', () =>
    Effect.gen(function* () {
      // The "recorded result" stands in for Buck's reaped exit code + stdout:
      // captured BEFORE any telemetry exists. A whole OTLP exporter lifecycle
      // (every signal POSTing at a closed port) runs in between; afterwards
      // the recorded result must be byte-for-byte unchanged.
      const recordedResult = yield* Ref.make({ exitCode: 0, stdout: 'BUCK_STDOUT_MARKER' })

      const failingExportLayer = Otlp.layerJson({
        baseUrl: 'http://127.0.0.1:9', // discard port: nothing listens
        resource: { serviceName: SERVICE },
        loggerExportInterval: 20,
        metricsExportInterval: 20,
        shutdownTimeout: 500,
        tracerExportInterval: 20,
      }).pipe(Layer.provide(FetchHttpClient.layer))

      const outcome = yield* Effect.exit(
        Effect.scoped(
          projectInvocation(observationFor(successEvidence())).pipe(
            Effect.provide(failingExportLayer),
          ),
        ),
      )
      // The projection itself completed (telemetry outcome is its own concern).
      expect(Exit.isSuccess(outcome)).toBe(true)

      const after = yield* Ref.get(recordedResult)
      expect(after).toStrictEqual({ exitCode: 0, stdout: 'BUCK_STDOUT_MARKER' })
    }),
    30_000,
  )

  it('dead-exporter child control: exit code + stdout preserved end to end', () => {
    // Process-level shape of R08 for the direct path: a child that records its
    // "Buck" result FIRST, then attempts an OTLP export at a closed port, then
    // reports. Export failure cannot touch exit code or stdout.
    const childScript = `
      const recorded = JSON.stringify({ exitCode: 0, stdout: 'BUCK_STDOUT_MARKER' });
      try {
        await fetch('http://127.0.0.1:9/v1/traces', { method: 'POST', body: '{}' });
      } catch {}
      console.log('BUCK_RESULT=' + recorded);
      process.exit(Number(JSON.parse(recorded).exitCode));
    `
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(stdout).toContain('exitCode')
    expect(stdout).toContain('BUCK_STDOUT_MARKER')
  })

  it('cardinality guard fails loudly on an unbounded label', () => {
    const poisoned = [
      {
        schema: 'otelite.metric/v1' as const,
        service: SERVICE,
        name: 'buck2_invocations_total',
        type: 'sum',
        unit: '1',
        value: 1,
        time_unix_nano: '0',
        attrs: { [SpanAttrKeys.invocationId]: 'inv-3f9a2c7' },
      },
    ]
    expect(() => guardMetricCardinality(poisoned)).toThrow(/invocation\.id/)
  })
})
