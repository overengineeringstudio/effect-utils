/**
 * Evidence → spans/metrics projection (spec "Signals", BUCK.OBS-R04..R08).
 *
 * Lane-local decisions recorded here:
 *
 * - **Capture path**: the authoritative local round-trip is the in-process
 *   `OteliteTestHarness` receiver (`@overeng/utils-dev/otelite`) — a real OTLP
 *   receiver, no resident observer. The projection itself is harness-agnostic
 *   Effect code and runs identically against any OTLP endpoint.
 * - **Span LINK**: the independent `nix.import` span carries a real W3C span
 *   LINK to the `buck.invocation` span (plus mirrored `evidence.link.*`
 *   attributes so flat row inspectors can assert it). The invocation ID is a
 *   correlation ATTRIBUTE everywhere — never trace identity.
 * - **Retention**: callers keep native evidence in a disposable run directory
 *   (CI) with keep-on-failure; this module only sanitizes what it exports.
 * - **No observer** (decision 0011): nothing here wraps or interposes on the
 *   Buck process; everything is post-exit decoding of native evidence.
 *
 * Export independence (BUCK.OBS-R08) is structural: telemetry emission happens
 * AFTER the Buck child has been reaped and its exit code/stdout captured; a
 * failing exporter can only fail THIS effect, never rewrite the recorded
 * result.
 */
import { Context, Effect, Option, Schema } from 'effect'
import type { ExternalSpan } from 'effect/Tracer'

import type { DecodedEvidence, Verdict } from './model.ts'
import { sanitizeArgv, sanitizeEnv, sanitizeHostPath } from './sanitize.ts'
import {
  BuckInvocationCountBridge,
  BuckInvocationDurationMsBridge,
  SanitizedAttrKeys,
  SpanAttrKeys,
  SpanNames,
  type BuckMetricLabels,
} from './telemetry.ts'

/**
 * Schema-backed JSON serialization for the sanitized argv vector — satisfies
 * the preferSchemaOverJson discipline (`Schema.parseJson`, never raw
 * `JSON.stringify`).
 */
const SanitizedArgvJson = Schema.parseJson(Schema.Array(Schema.String))

/**
 * Carries the recorded Buck outcome into the invocation span's error status.
 * Contained by `Effect.ignore`; never rewrites the result.
 */
class BuckOutcomeRecorded extends Error {
  readonly _tag = 'BuckOutcomeRecorded'
  constructor(readonly resultClass: string) {
    super(`buck invocation recorded as ${resultClass}`)
  }
}

/** How the caller observed the finished Buck invocation, pre-sanitization. */
export interface InvocationObservation {
  /** Sanitized on export by {@link sanitizeArgv} — flag values never survive. */
  readonly argv?: ReadonlyArray<string> | undefined
  /** Raw build report path; sanitized to repo-relative or redacted. */
  readonly buildReportPath?: string | undefined
  /**
   * Wall-clock duration of the actual Buck child, measured by the control
   * plane around the direct process spawn — NOT the projection's own runtime.
   */
  readonly durationMs: number
  /** Environment of the child; values are NEVER exported (only the count). */
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly evidence: DecodedEvidence
  readonly operationKind: BuckMetricLabels['operation-kind']
  readonly platformClass: BuckMetricLabels['platform-class']
  /** Raw event-log path; sanitized to repo-relative or redacted. */
  readonly eventLogPath?: string | undefined
  readonly verdict: Verdict
  readonly workspaceRoot?: string | undefined
}

/** Aggregate result class used for spans + metric labels. */
export const resultClassFor = ({
  evidence,
  verdict,
}: {
  readonly evidence: DecodedEvidence
  readonly verdict: Verdict
}): BuckMetricLabels['result-class'] => {
  if (verdict._tag === 'NO_VERDICT') return 'no-verdict'
  const success =
    evidence.buildReport !== null && evidence.buildReport._tag === 'Decoded'
      ? evidence.buildReport.report.success
      : undefined
  // PASS/FAIL verdicts imply a decoded report, so success is defined here.
  return success === true ? 'success' : 'failure'
}

/** Bounded aggregate cache class across all admitted action records. */
export const cacheClassFor = (evidence: DecodedEvidence): BuckMetricLabels['cache-class'] => {
  if (evidence.eventLog === null || evidence.eventLog._tag !== 'DecodedEventLog') return 'unknown'
  const actions = evidence.eventLog.log.actions
  if (actions.length === 0) return 'unknown'
  let hits = 0
  for (const action of actions) {
    if (action.cache_class === 'unknown') return 'unknown'
    if (action.cache_class === 'hit') hits += 1
  }
  if (hits === actions.length) return 'hit'
  if (hits === 0) return 'miss'
  return 'partial'
}

interface CapturedIds {
  spanId?: string
  traceId?: string
}

const externalSpanFrom = ({ spanId, traceId }: Required<CapturedIds>): ExternalSpan => ({
  _tag: 'ExternalSpan',
  context: Context.empty(),
  sampled: true,
  spanId,
  traceId,
})

// The projection emits its four spans with raw `Effect.withSpan`: this is the
// ONE boundary where the schema-first contracts cannot follow. `OtelSpan`
// contracts cannot express span kind CLIENT, dynamic per-record names, or W3C
// LINKS to an ExternalSpan (`nix.import` → `buck.invocation`). That expressivity
// gap is exactly the "measured gap" decision 0011 demands before adding
// machinery; when @overeng/otel-contract grows kind/link support these five
// call sites migrate mechanically.

/**
 * Project one finished Buck invocation onto traces + metrics.
 *
 * Trace shape (below whatever ambient parent the control plane provides):
 * ```
 * buck.invocation (CLIENT)
 *   |-- buck.action                    (per admitted rich action record)
 *   |-- buck.artifact.materialized     (per admitted rich materialization)
 *   `-- buck.evidence.decode           (normalization + verdict recording)
 * nix.import (independent sibling; LINK -> buck.invocation)
 * ```
 *
 * With NO_VERDICT evidence the decode span still records WHY, but zero rich
 * action/materialization spans exist — "no exact cause may be inferred"
 * becomes a visible structural fact in the trace.
 */
export const projectInvocation = ({
  argv = [],
  buildReportPath,
  durationMs,
  env = {},
  eventLogPath,
  evidence,
  operationKind,
  platformClass,
  verdict,
  workspaceRoot,
}: InvocationObservation): Effect.Effect<void> => {
  // Serialized OUTSIDE any Effect generator so the throwing sync bridge
  // (Schema.encodeSync on a pure array) never runs mid-effect.
  const argvJson =
    argv.length > 0 ? Schema.encodeSync(SanitizedArgvJson)(sanitizeArgv({ argv })) : undefined
  return Effect.gen(function* () {
    const resultClass = resultClassFor({ evidence, verdict })
    const labels: BuckMetricLabels = {
      'cache-class': cacheClassFor(evidence),
      'operation-kind': operationKind,
      'platform-class': platformClass,
      'result-class': resultClass,
    }

    const invocationAttrs: Record<string, string | number> = {
      [SpanAttrKeys.commandKind]: operationKind,
      [SpanAttrKeys.envCount]: sanitizeEnv(env).count,
      [SpanAttrKeys.platformClass]: platformClass,
      [SpanAttrKeys.resultClass]: resultClass,
      [SpanAttrKeys.verdict]: verdict._tag,
      'span.label': `${operationKind}:${resultClass}`,
    }
    if (buildReportPath !== undefined) {
      invocationAttrs[SpanAttrKeys.buildReportPath] = sanitizeHostPath({
        path: buildReportPath,
        workspaceRoot,
      })
    }
    if (eventLogPath !== undefined) {
      invocationAttrs[SpanAttrKeys.eventLogPath] = sanitizeHostPath({
        path: eventLogPath,
        workspaceRoot,
      })
    }
    if (argv.length > 0) {
      if (argvJson !== undefined) {
        invocationAttrs[SanitizedAttrKeys.argv] = argvJson
      }
    }
    if (evidence.eventLog !== null && evidence.eventLog._tag === 'DecodedEventLog') {
      // Buck's own trace id is the invocation correlation id — never trace identity.
      invocationAttrs[SpanAttrKeys.invocationId] = evidence.eventLog.log.buckTraceId
    }

    // Capture the invocation span's identity from INSIDE it, then record the
    // outcome: success ends ok, anything else fails (error status). The failure
    // stays contained so the projection itself always succeeds.
    const ids: CapturedIds = {}
    yield* Effect.gen(function* () {
      // `Effect.currentSpan` FAILS outside tracing; make it an Option so a
      // no-tracer runtime simply skips link creation below.
      const current = yield* Effect.currentSpan.pipe(Effect.option)
      if (Option.isSome(current) === true) {
        ids.spanId = current.value.spanId
        ids.traceId = current.value.traceId
      }
      if (statusError(resultClass) === true) {
        return yield* Effect.fail(new BuckOutcomeRecorded(resultClass))
      }
      yield* Effect.void
    }).pipe(
      // oxlint-disable-next-line overeng/no-raw-otel-primitives -- see block comment above (CLIENT kind)
      Effect.withSpan(SpanNames.invocation, { attributes: invocationAttrs, kind: 'client' }),
      Effect.ignore,
    )

    const log =
      evidence.eventLog !== null && evidence.eventLog._tag === 'DecodedEventLog'
        ? evidence.eventLog.log
        : undefined
    for (const action of log?.actions ?? []) {
      yield* Effect.void.pipe(
        // oxlint-disable-next-line overeng/no-raw-otel-primitives -- dynamic per-action name (see block comment above)
        Effect.withSpan(SpanNames.action, {
          attributes: <Record<string, string | number>>{
            ...(action.wallTimeUs === undefined
              ? {}
              : { 'buck.action.duration_ms': action.wallTimeUs / 1000 }),
            ...(action.targetLabel === undefined
              ? {}
              : { [SpanAttrKeys.target]: action.targetLabel }),
            [SpanAttrKeys.cacheClass]: action.cache_class,
            // Empirical per-action result: the action's own failed flag.
            [SpanAttrKeys.resultClass]:
              action.failed === true ? ('failure' as const) : ('success' as const),
            'span.label': action.targetLabel ?? action.category ?? 'action',
          },
        }),
      )
    }
    for (const materialization of log?.materializations ?? []) {
      // R07: materialization paths go through the SAME host-path policy as
      // every other path — attribute AND label.
      const artifactPath =
        materialization.path === undefined
          ? undefined
          : sanitizeHostPath({ path: materialization.path, workspaceRoot })
      yield* Effect.void.pipe(
        // oxlint-disable-next-line overeng/no-raw-otel-primitives -- path attrs on a rich record (see block comment above)
        Effect.withSpan('buck.artifact.materialized', {
          attributes: <Record<string, string | number>>{
            ...(artifactPath === undefined ? {} : { 'buck.artifact.path': artifactPath }),
            'span.label': artifactPath ?? 'artifact',
          },
        }),
      )
    }
    yield* Effect.void.pipe(
      // oxlint-disable-next-line overeng/no-raw-otel-primitives -- verdict state attrs (see block comment above)
      Effect.withSpan(SpanNames.evidenceDecode, {
        attributes: {
          'buck.evidence.build_report.decoded':
            evidence.buildReport?._tag === 'Decoded' ? 'true' : 'false',
          'buck.evidence.event_log.state':
            evidence.eventLog === null ? 'absent' : evidence.eventLog._tag,
          [SpanAttrKeys.verdict]:
            verdict._tag === 'NO_VERDICT' ? `NO_VERDICT:${verdict.cause}` : verdict._tag,
          'span.label': SpanNames.evidenceDecode,
        },
      }),
    )

    // Independent import span: root-level sibling, LINKED to the invocation.
    if (ids.spanId !== undefined && ids.traceId !== undefined) {
      yield* Effect.void.pipe(
        // oxlint-disable-next-line overeng/no-raw-otel-primitives -- W3C span LINK unsupported by OtelSpan contracts
        Effect.withSpan(SpanNames.import, {
          attributes: <Record<string, string | number>>{
            'import.result-class': resultClass,
            [SpanAttrKeys.linkSpanId]: ids.spanId,
            [SpanAttrKeys.linkTraceId]: ids.traceId,
            'span.label': SpanNames.import,
          },
          links: [
            {
              _tag: 'SpanLink',
              attributes: {},
              span: externalSpanFrom({ spanId: ids.spanId, traceId: ids.traceId }),
            },
          ],
        }),
      )
    }

    yield* BuckInvocationCountBridge.trustedIncrement(labels)
    yield* BuckInvocationDurationMsBridge.trustedRecord({ labels, value: durationMs })
  })
}

const statusError = (resultClass: string): boolean => resultClass !== 'success'
