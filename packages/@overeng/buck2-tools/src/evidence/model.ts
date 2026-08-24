/**
 * Native-evidence model for the Buck two-tier decoder.
 *
 * Ground truth is always Buck's own native evidence (BUCK.OBS-A01): the build
 * report (`--build-report <path|->`) and the event log (`--event-log <file>`).
 * Every shape below is derived from EMPIRICAL captures of the pinned Buck2
 * binary (2026-04-15) against a real probe project — checked-in fixtures are
 * trimmed, sanitized copies of those artifacts, never invented.
 *
 * Two tiers (BUCK.OBS-T01 / spec "Evidence Adapter"):
 *
 * 1. **Stable tier** — the build report's documented aggregate fields. The
 *    schema REQUIRES the report's discriminative anchors (`trace_id`,
 *    `success`, `project_root`, `truncated`), so arbitrary JSON objects fail
 *    decode into NO_VERDICT instead of ever fabricating a verdict. Unknown
 *    upstream properties are ignored additively.
 * 2. **Rich tier** — the event log: a gzip-compressed JSONL stream whose first
 *    line is a header (`command_line_args`/`working_dir`/`trace_id`/
 *    `start_time`) followed by `{"Event": …}` rows. The adapter extracts
 *    action-execution and materialization span-ends; everything else passes
 *    through untouched as raw evidence.
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

/** Verification outcome: PASS, FAIL, or an explicit NO_VERDICT with its cause. */
export type Verdict =
  | { readonly _tag: 'PASS' }
  | { readonly _tag: 'FAIL'; readonly reason: string }
  | { readonly _tag: 'NO_VERDICT'; readonly cause: NoVerdictCause }

// ---------------------------------------------------------------------------
// Tier 1 — stable build report (empirical pinned-binary shape)
// ---------------------------------------------------------------------------

/**
 * Typed view of one target record in the stable build report. Empirically,
 * `outputs` is a map of output-group -> artifact path list (e.g.
 * `{"DEFAULT": ["buck-out/..."]}`).
 */
export interface BuildReportTarget {
  readonly outcome?: string
  readonly outputs?: Readonly<Record<string, ReadonlyArray<string>>>
}

/**
 * Documented aggregate build-report fields. The anchors are REQUIRED so an
 * unrecognized JSON object decodes to Malformed — never to a fabricated FAIL.
 */
export interface StableBuildReport {
  readonly failures?: Readonly<Record<string, unknown>>
  readonly project_root: string
  readonly results?: Readonly<Record<string, BuildReportTarget>>
  readonly success: boolean
  readonly trace_id: string
  readonly truncated: boolean
}

/** Schema mirror of one target record (outputs: group -> path list, empirically). */
export const BuildReportTargetSchema = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  outputs: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
})

/** Schema mirror of {@link StableBuildReport}; unknown upstream properties are ignored. */
export const StableBuildReport = Schema.Struct({
  failures: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  project_root: Schema.String,
  results: Schema.optional(Schema.Record({ key: Schema.String, value: BuildReportTargetSchema })),
  success: Schema.Boolean,
  trace_id: Schema.String,
  truncated: Schema.Boolean,
})

/** Tier-1 decode result: a decoded stable view or an explicit malformed marker. */
export type BuildReportResult =
  | { readonly _tag: 'Decoded'; readonly report: StableBuildReport }
  | { readonly _tag: 'Malformed'; readonly detail: string }

// ---------------------------------------------------------------------------
// Tier 2 — event log adapter (gzip JSONL; header + Event rows)
// ---------------------------------------------------------------------------

/** Rich-tier view over one admitted event log. */
export interface EventLogView {
  /** Per-action execution span-ends, with bounded cache class. */
  readonly actions: ReadonlyArray<EventLogAction>
  /** Materialized-artifact paths exactly as Buck reported them (sanitize at export). */
  readonly materializations: ReadonlyArray<EventLogMaterialization>
  /** Buck's own invocation trace id — the correlation id for this invocation. */
  readonly buckTraceId: string
}

/** One admitted action record; cache class derives from the empirical execution_kind. */
export interface EventLogAction {
  readonly cache_class: 'hit' | 'miss' | 'unknown'
  readonly category?: string
  readonly failed: boolean
  readonly targetLabel?: string
  readonly wallTimeUs?: number
}

/** One admitted materialization record. */
export interface EventLogMaterialization {
  readonly path?: string
}

/** Header-line anchors of an admitted event log (field-set match, not a version tag). */
export const EventLogHeader = Schema.Struct({
  command_line_args: Schema.Array(Schema.String),
  start_time: Schema.Array(Schema.Number),
  trace_id: Schema.String,
  working_dir: Schema.String,
})

/** Keys that MUST be present on the header line for the log to be interpretable. */
export const EventLogHeaderAnchorKeys: ReadonlySet<string> = new Set([
  'command_line_args',
  'start_time',
  'trace_id',
  'working_dir',
])

/** Tier-2 decode result across decoded and malformed logs (no version tags exist). */
export type EventLogResult =
  | { readonly _tag: 'DecodedEventLog'; readonly log: EventLogView }
  | { readonly _tag: 'MalformedEventLog'; readonly detail: string }

// ---------------------------------------------------------------------------
// Combined decode result
// ---------------------------------------------------------------------------

/** Both tiers at once; a `null` artifact was not captured at all (distinct from malformed). */
export interface DecodedEvidence {
  readonly buildReport: BuildReportResult | null
  readonly eventLog: EventLogResult | null
}
