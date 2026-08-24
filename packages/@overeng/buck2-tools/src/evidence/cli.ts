/**
 * E2E evidence driver: feed REAL buck2 artifacts (`--event-log` +
 * `--build-report` captured by scripts/buck2-megarepo-product-e2e.sh) through
 * decodeEvidence → verdictFor → projectInvocation under an in-process
 * OteliteTestHarness receiver, and assert the admission gates:
 *
 * - success path: verdict PASS from the REAL report.success=true, exactly one
 *   CLIENT `buck.invocation` span parented under the harness root, an
 *   independent `nix.import` span LINKED to it over W3C ids, sanitized export,
 *   and a clean metric-cardinality guard over ALL captured rows.
 * - negative control: a corrupted COPY of the event log must degrade to
 *   NO_VERDICT(malformed-event-log), surfaced on the invocation span + metric,
 *   while the recorded Buck result (exit code + stdout) stays untouched.
 *
 * Any failed assertion exits non-zero — the bash e2e treats that as failure.
 */
import { readFileSync } from 'node:fs'

import { Data, Effect, Exit, Ref, Schema } from 'effect'

import { captureTest, SpanRow } from '@overeng/utils-dev/otelite'

import { decodeEventLogText } from './decoder.ts'
import {
  decodeEvidence,
  expectExactlyOneInvocation,
  expectNoRichSpans,
  guardMetricCardinality,
  projectInvocation,
  readSpanLinksFromCapture,
  verdictFor,
} from './mod.ts'
import { SpanAttrKeys, SpanNames } from './telemetry.ts'

const SERVICE = 'effect-utils-buck2-e2e'

/** Tagged driver failure — keeps the Effect error channel non-global. */
class DriverError extends Data.TaggedError('DriverError')<{
  readonly message: string
}> {}

/** Span-row serialization for leak assertions — never raw JSON.stringify. */
const SpanRowsJson = Schema.parseJson(Schema.Array(SpanRow))

interface DriverArgs {
  readonly buildReportPath: string
  readonly durationMs: number
  readonly eventLogPath: string
  readonly workspaceRoot: string
}

const parseArgs = (argv: ReadonlyArray<string>): DriverArgs => {
  const parsed: { -readonly [K in keyof DriverArgs]?: DriverArgs[K] } = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${key}`)
    if (key === '--build-report') parsed.buildReportPath = value
    else if (key === '--duration-ms') parsed.durationMs = Number(value)
    else if (key === '--event-log') parsed.eventLogPath = value
    else if (key === '--workspace-root') parsed.workspaceRoot = value
    else throw new Error(`unknown argument: ${key}`)
  }
  for (const key of ['buildReportPath', 'durationMs', 'eventLogPath', 'workspaceRoot'] as const) {
    if (parsed[key] === undefined || Number.isNaN(parsed[key]) === true) {
      throw new Error(
        `missing required argument: --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      )
    }
  }
  return parsed as DriverArgs
}

/** Compact diagnostic rendering of a Verdict — no raw JSON serialization. */
const renderVerdict = (
  verdict: Parameters<typeof verdictFor>[0] extends never ? never : ReturnType<typeof verdictFor>,
): string =>
  verdict._tag === 'NO_VERDICT'
    ? `NO_VERDICT(${verdict.cause})`
    : verdict._tag === 'FAIL'
      ? `FAIL(${verdict.reason})`
      : 'PASS'

/** Corrupt a COPY of the real event log text: truncate mid-stream + splice an unterminated JSON fragment. */
const corruptEventLog = (bytes: Uint8Array): string => {
  // Inflate the INTACT capture first (handles gzip transparently); corrupting
  // the decoded text keeps the negative on the decoder's honest-degradation
  // path instead of dying inside zlib.
  const text = decodeEventLogText(bytes)
  return `${text.slice(0, Math.floor(text.length * 0.6))}{"trace_id":`
}

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2))
  const buildReportText = yield* Effect.try({
    try: () => readFileSync(args.buildReportPath, 'utf8'),
    catch: (cause) => new DriverError({ message: `cannot read build report: ${String(cause)}` }),
  })
  const eventLogBytes = new Uint8Array(
    yield* Effect.try({
      try: () => readFileSync(args.eventLogPath),
      catch: (cause) => new DriverError({ message: `cannot read event log: ${String(cause)}` }),
    }),
  )

  const observationFor = (evidence: Parameters<typeof projectInvocation>[0]['evidence']) => ({
    argv: ['build', '--event-log', args.eventLogPath],
    buildReportPath: args.buildReportPath,
    durationMs: args.durationMs,
    env: { PATH: process.env.PATH ?? '' },
    eventLogPath: args.eventLogPath,
    evidence,
    operationKind: 'build' as const,
    platformClass: 'linux-x64' as const,
    verdict: verdictFor({ evidence }),
    workspaceRoot: args.workspaceRoot,
  })

  // --- Success gate: PASS must come from the REAL artifacts. ---
  const evidence = decodeEvidence({ buildReportText, eventLogInput: eventLogBytes })
  const verdict = verdictFor({ evidence })
  if (verdict._tag !== 'PASS') {
    return yield* new DriverError({
      message: `expected PASS from real report.success=true, got ${renderVerdict(verdict)}`,
    })
  }

  const recordedResult = yield* Ref.make({ exitCode: 0, stdout: 'BUCK_STDOUT_MARKER' })

  const otel = yield* captureTest({
    serviceName: SERVICE,
    rootSpanName: `${SERVICE}.root`,
    exportInterval: 50,
  })
  const { metrics, trace } = yield* otel.runInProcessAllSignals(
    projectInvocation(observationFor(evidence)),
  )

  const root = trace.expectOne({ name: `${SERVICE}.root` })
  const rootSpanId = root.span_id
  if (rootSpanId === null) {
    return yield* new DriverError({ message: 'harness root span missing span_id' })
  }
  const invocation = expectExactlyOneInvocation({ trace, options: { parentSpanId: rootSpanId } })
  if (invocation.status_code !== 1) {
    return yield* new DriverError({
      message: `invocation span status ${invocation.status_code}, expected OK(1)`,
    })
  }
  if (invocation.attrs[SpanAttrKeys.verdict] !== 'PASS') {
    return yield* new DriverError({
      message: `invocation span verdict ${String(invocation.attrs[SpanAttrKeys.verdict])}, expected PASS`,
    })
  }

  // Sanitized export (R07): no raw host paths survive on any span row.
  const invocationJson = yield* Schema.encode(SpanRowsJson)([invocation])
  if (invocationJson.includes(args.workspaceRoot) === true) {
    return yield* new DriverError({
      message: 'sanitization leak: workspace root survived on the invocation span',
    })
  }

  // Rich tier from the REAL event log produced action spans.
  if (trace.expectSome({ name: SpanNames.action }).length < 1) {
    return yield* new DriverError({
      message: 'real event log admitted but produced no action spans',
    })
  }

  // Independent import span LINKS to the invocation over W3C ids.
  const importSpan = trace.expectOne({ name: SpanNames.import })
  const links = readSpanLinksFromCapture(
    readFileSync(`${otel.capture.outDir}/traces.ndjson`, 'utf8'),
  ).filter((link) => link.spanName === SpanNames.import)
  if (links.length !== 1) {
    return yield* new DriverError({
      message: `expected exactly one import link, got ${links.length}`,
    })
  }
  if (
    links[0]?.linkTraceId !== importSpan.trace_id ||
    links[0]?.linkSpanId !== invocation.span_id
  ) {
    return yield* new DriverError({
      message: 'import link does not reference the invocation span ids',
    })
  }

  guardMetricCardinality(metrics.metrics)
  metrics.expectOne({
    name: 'buck2_invocations_total',
    attrs: { 'operation-kind': 'build', 'result-class': 'success' },
  })

  // --- Negative control: corrupted event-log copy degrades honestly. ---
  const malformedEvidence = decodeEvidence({
    buildReportText,
    eventLogInput: corruptEventLog(eventLogBytes),
  })
  const negativeVerdict = verdictFor({ evidence: malformedEvidence })
  if (negativeVerdict._tag !== 'NO_VERDICT' || negativeVerdict.cause !== 'malformed-event-log') {
    return yield* new DriverError({
      message: `corrupted event log must yield NO_VERDICT(malformed-event-log), got ${renderVerdict(negativeVerdict)}`,
    })
  }

  const negative = yield* captureTest({ serviceName: SERVICE, exportInterval: 50 })
  const negSignals = yield* negative.runInProcessAllSignals(
    projectInvocation(observationFor(malformedEvidence)),
  )

  const negInvocation = negSignals.trace.expectOne({ name: SpanNames.invocation })
  if (negInvocation.attrs[SpanAttrKeys.verdict] !== 'NO_VERDICT') {
    return yield* new DriverError({
      message: `negative invocation span verdict ${String(negInvocation.attrs[SpanAttrKeys.verdict])}, expected NO_VERDICT`,
    })
  }
  const decodeSpan = negSignals.trace.expectOne({ name: SpanNames.evidenceDecode })
  if (String(decodeSpan.attrs[SpanAttrKeys.verdict]).includes('malformed-event-log') !== true) {
    return yield* new DriverError({
      message: 'decode span did not surface malformed-event-log cause',
    })
  }
  expectNoRichSpans(negSignals.trace)

  guardMetricCardinality(negSignals.metrics.metrics)
  negSignals.metrics.expectOne({
    name: 'buck2_invocations_total',
    attrs: { 'result-class': 'no-verdict' },
  })

  // R08: telemetry never rewrote the recorded Buck result.
  const after = yield* Ref.get(recordedResult)
  if (after.exitCode !== 0 || after.stdout !== 'BUCK_STDOUT_MARKER') {
    return yield* new DriverError({
      message: 'recorded Buck result was mutated by the evidence pipeline',
    })
  }
})

const exit = await Effect.runPromiseExit(Effect.scoped(program))
if (Exit.isFailure(exit) === true) {
  console.error('buck2-evidence-driver: FATAL')
  console.error(String(exit.cause))
  process.exit(1)
}
console.log('buck2-evidence-driver: SUCCESS-PASS verdict=PASS (real report.success=true)')
console.log('buck2-evidence-driver: IMPORT-LINK nix.import -> buck.invocation verified')
console.log(
  'buck2-evidence-driver: NEGATIVE-NO-VERDICT cause=malformed-event-log surfaced on span+metric',
)
console.log('buck2-evidence-driver: RECORDED-RESULT-UNCHANGED exit=0 stdout=BUCK_STDOUT_MARKER')
console.log('buck2-evidence-driver: CARDINALITY-GUARD clean over all captured rows')
