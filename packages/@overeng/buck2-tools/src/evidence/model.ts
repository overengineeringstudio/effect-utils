/**
 * Native-evidence model for the Buck two-tier decoder.
 *
 * Ground truth is always Buck's own native evidence (BUCK.OBS-A01): the build
 * report (`--build-report <path|->`) and the event log (`--event-log <file>`).
 * This module defines ONLY the typed views the decoder projects onto those
 * artifacts — it never defines an independent evidence/receipt schema
 * (decision 0011: no custom receipt).
 *
 * Two tiers (BUCK.OBS-T01 / spec "Evidence Adapter"):
 *
 * 1. **Stable tier** — additive-tolerant decoding of documented aggregate
 *    build-report fields. Unknown properties are ignored, missing properties
 *    are represented as absent, never guessed.
 * 2. **Rich tier** — a version-bound event-log adapter. The adapter admits a
 *    fixed set of Buck versions; anything else is retained as raw evidence and
 *    marked unsupported for rich interpretation (BUCK.OBS-R03).
 */
import { Schema } from 'effect'

// ---------------------------------------------------------------------------
// Verdicts (spec "Verdicts")
// ---------------------------------------------------------------------------

/** Why a verdict could not be produced. Each cause is explicit — never inferred. */
export type NoVerdictCause =
  | 'missing-build-report'
  | 'missing-event-log'
  | 'malformed-build-report'
  | 'malformed-event-log'
  | 'unsupported-event-log-version'

/** Verification outcome: PASS, FAIL, or an explicit NO_VERDICT with its cause. */
export type Verdict =
  | { readonly _tag: 'PASS' }
  | { readonly _tag: 'FAIL'; readonly reason: string }
  | { readonly _tag: 'NO_VERDICT'; readonly cause: NoVerdictCause }

// ---------------------------------------------------------------------------
// Tier 1 — stable build report (additive-tolerant)
// ---------------------------------------------------------------------------

/** Schema mirror of one declared output record. */
export const BuildReportOutputSchema = Schema.Struct({
  digest_sha256: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
})

/** One declared output of one target, as far as the stable tier cares. */
export interface BuildReportOutput {
  readonly digest_sha256?: string
  readonly label?: string
  readonly path?: string
}

/** Typed view of one target record in the stable build report. */
export interface BuildReportTarget {
  readonly outcome?: string
  readonly outputs?: ReadonlyArray<BuildReportOutput>
}

/** Documented aggregate build-report fields (additive-tolerant view). */
export interface StableBuildReport {
  readonly outcome?: string
  readonly targets?: Readonly<Record<string, BuildReportTarget>>
  readonly version?: string
}

/** Schema mirror of one target record. */
export const BuildReportTargetSchema = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  outputs: Schema.optional(Schema.Array(BuildReportOutputSchema)),
})

/** Schema mirror of {@link StableBuildReport}; unknown upstream properties are ignored. */
export const StableBuildReport = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  targets: Schema.optional(Schema.Record({ key: Schema.String, value: BuildReportTargetSchema })),
  version: Schema.optional(Schema.String),
})

/** Tier-1 decode result: a decoded stable view or an explicit malformed marker. */
export type BuildReportResult =
  | { readonly _tag: 'Decoded'; readonly report: StableBuildReport }
  | { readonly _tag: 'Malformed'; readonly detail: string }

// ---------------------------------------------------------------------------
// Tier 2 — version-bound event log adapter
// ---------------------------------------------------------------------------

/** The Buck versions whose event-log shape this adapter admits (see module doc). */
export const AdmittedEventLogVersions = ['2026-04-15'] as const

/** A Buck version whose event-log format the rich tier admits. */
export type AdmittedEventLogVersion = (typeof AdmittedEventLogVersions)[number]

/** Header line schema of an admitted event log (`buck2.event-log/v1`). */
export const EventLogHeader = Schema.Struct({
  buck_version: Schema.String,
  invocation_id: Schema.String,
  schema: Schema.Literal('buck2.event-log/v1'),
})

/** One admitted action record; cache class is bounded vocabulary, not free text. */
export interface EventLogAction {
  readonly action_id: string
  readonly cache_class: 'hit' | 'miss' | 'unknown'
  readonly duration_ms?: number
  readonly status: 'success' | 'failure'
  readonly target?: string
}

/** Schema mirror of one admitted action record. */
export const EventLogAction = Schema.Struct({
  action_id: Schema.String,
  cache_class: Schema.Literal('hit', 'miss', 'unknown'),
  duration_ms: Schema.optional(Schema.Number),
  status: Schema.Literal('success', 'failure'),
  target: Schema.optional(Schema.String),
})

/** One admitted materialization record. */
export interface EventLogMaterialization {
  readonly digest_sha256?: string
  readonly path?: string
  readonly size_bytes?: number
}

/** Schema mirror of one admitted materialization record. */
export const EventLogMaterialization = Schema.Struct({
  digest_sha256: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  size_bytes: Schema.optional(Schema.Number),
})

/** Rich-tier view over an admitted event log. */
export interface EventLogView {
  readonly actions: ReadonlyArray<EventLogAction>
  readonly buckVersion: AdmittedEventLogVersion
  readonly formatVersion: 1
  readonly invocationId: string
  readonly materializations: ReadonlyArray<EventLogMaterialization>
}

/** Union of admitted event-log record shapes (post-header lines). */
export const EventLogLine = Schema.Union(
  Schema.Struct({
    payload: EventLogAction,
    type: Schema.Literal('action_ended'),
  }),
  Schema.Struct({
    payload: EventLogMaterialization,
    type: Schema.Literal('artifact_materialized'),
  }),
)

/** Tier-2 decode result across admitted, unsupported, and malformed logs. */
export type EventLogResult =
  | { readonly _tag: 'DecodedEventLog'; readonly log: EventLogView }
  | { readonly _tag: 'MalformedEventLog'; readonly detail: string }
  | { readonly _tag: 'UnsupportedEventLogVersion'; readonly buckVersion: string | null }

// ---------------------------------------------------------------------------
// Combined decode result
// ---------------------------------------------------------------------------

/** Both tiers at once; a `null` artifact was not captured at all (distinct from malformed). */
export interface DecodedEvidence {
  readonly buildReport: BuildReportResult | null
  readonly eventLog: EventLogResult | null
}
