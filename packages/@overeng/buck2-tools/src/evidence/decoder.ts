/**
 * The two-tier evidence decoder (spec "Evidence Adapter").
 *
 * Pure bytes-in/result-out: file IO and retention belong to the calling
 * control plane (BUCK.OBS-R01), so the decoder stays trivially testable and
 * can never rewrite execution truth — it only projects typed views onto it.
 *
 * Tier 1 decodes the stable build report; its discriminative anchors are
 * REQUIRED, so arbitrary JSON degrades to Malformed (NO_VERDICT) and can never
 * fabricate a FAIL.
 *
 * Tier 2 decodes the event log: gzip-compressed JSONL with a header line
 * (`command_line_args`/`working_dir`/`trace_id`/`start_time`) followed by
 * `{"Event": …}` rows. Real logs carry NO version tag — interpretability is
 * keyed off the header field-set anchor instead. Rows that are not
 * action-execution or materialization span-ends are ignored (additive
 * tolerance); `what-ran`/`what-materialized` summaries are never consulted.
 */
import { gunzipSync } from 'node:zlib'

import { Either, ParseResult, Schema } from 'effect'

import {
  EventLogHeader,
  EventLogHeaderAnchorKeys,
  StableBuildReport,
  type BuildReportResult,
  type DecodedEvidence,
  type EventLogAction,
  type EventLogMaterialization,
  type EventLogResult,
} from './model.ts'

/** Format one Schema decode failure as a compact, path-aware message. */
const formatIssue = (issue: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(issue)
    .map((issueItem) =>
      issueItem.path.length === 0
        ? issueItem.message
        : `${issueItem.path.join('.')}: ${issueItem.message}`,
    )
    .join('; ')

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/** Decode event-log input: transparently inflates gzip streams, passes text through. */
export const decodeEventLogText = (input: Uint8Array | string): string => {
  if (typeof input !== 'string') {
    if (input.length >= 2 && input[0] === GZIP_MAGIC_0 && input[1] === GZIP_MAGIC_1) {
      return new TextDecoder().decode(gunzipSync(input))
    }
    return new TextDecoder().decode(input)
  }
  return input
}

/** Tier 1: additive-tolerant decode of a build report's stable fields. */
export const decodeBuildReport = (text: string): BuildReportResult => {
  if (text.trim() === '') {
    return { _tag: 'Malformed', detail: 'build report is empty' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    return { _tag: 'Malformed', detail: `invalid JSON: ${String(cause)}` }
  }
  return Either.match(Schema.decodeUnknownEither(StableBuildReport)(json), {
    // Unrecognized shapes MUST NOT become FAIL — they degrade explicitly (R03/R11).
    onLeft: (issue) => ({ _tag: 'Malformed', detail: formatIssue(issue) }),
    onRight: (report) => ({ _tag: 'Decoded', report: report as StableBuildReport }),
  })
}

/** Empirical row schemas: only these two span-end kinds carry rich claims. */
const ActionExecutionRow = Schema.Struct({
  Event: Schema.Struct({
    data: Schema.Struct({
      SpanEnd: Schema.Struct({
        duration_us: Schema.optional(Schema.Number),
        data: Schema.Struct({
          ActionExecution: Schema.Struct({
            execution_kind: Schema.optional(Schema.Number),
            failed: Schema.Boolean,
            key: Schema.optional(Schema.Unknown),
            name: Schema.optional(
              Schema.Struct({
                category: Schema.optional(Schema.String),
                identifier: Schema.optional(Schema.String),
              }),
            ),
            wall_time_us: Schema.optional(Schema.Number),
          }),
        }),
      }),
    }),
  }),
})

const MaterializationRow = Schema.Struct({
  Event: Schema.Struct({
    data: Schema.Struct({
      SpanEnd: Schema.Struct({
        data: Schema.Struct({
          FinalMaterialization: Schema.Struct({
            path: Schema.optional(Schema.String),
          }),
        }),
      }),
    }),
  }),
})

interface ParsedEventLogLine {
  readonly [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Extract `//pkg:name` from an empirical ActionExecution/FinalMaterialization owner key. */
const targetLabelOf = (owner: unknown): string | undefined => {
  if (
    isRecord(owner) === true &&
    'TargetLabel' in owner &&
    isRecord(owner.TargetLabel) === true &&
    'label' in owner.TargetLabel &&
    isRecord(owner.TargetLabel.label) === true
  ) {
    const label = owner.TargetLabel.label
    if (
      'package' in label &&
      typeof label.package === 'string' &&
      'name' in label &&
      typeof label.name === 'string'
    ) {
      return label.package.endsWith('//') === true
        ? `//${label.name}`
        : `${label.package}:${label.name}`
    }
  }
  return undefined
}

const cacheClassForExecutionKind = (executionKind: unknown): EventLogAction['cache_class'] => {
  if (executionKind === 10) return 'hit' // replayed from cache (empirical pinned binary)
  if (executionKind === 1) return 'miss' // locally executed
  return 'unknown'
}

/**
 * Tier 2: event-log decode. Accepts raw text OR gzip bytes. The header's
 * field-set is the interpretability anchor; rows other than ActionExecution /
 * FinalMaterialization span-ends are ignored additively.
 */
export const decodeEventLog = (input: Uint8Array | string): EventLogResult => {
  const text = decodeEventLogText(input)
  if (text.trim() === '') {
    return { _tag: 'MalformedEventLog', detail: 'event log is empty' }
  }

  let rawLines: ReadonlyArray<ParsedEventLogLine>
  try {
    rawLines = text
      .split('\n')
      .flatMap((line) => (line.trim() === '' ? [] : [JSON.parse(line) as ParsedEventLogLine]))
  } catch (cause) {
    return { _tag: 'MalformedEventLog', detail: `invalid JSON line: ${String(cause)}` }
  }

  const [rawHeader, ...rawRest] = rawLines
  if (rawHeader === undefined) {
    return { _tag: 'MalformedEventLog', detail: 'event log has no header line' }
  }
  for (const anchorKey of EventLogHeaderAnchorKeys) {
    if (Object.hasOwn(rawHeader, anchorKey) === false) {
      return {
        _tag: 'MalformedEventLog',
        detail: `header missing anchor '${anchorKey}' — log shape not interpretable`,
      }
    }
  }
  const header = Schema.decodeUnknownEither(EventLogHeader)(rawHeader)
  if (Either.isLeft(header) === true) {
    return {
      _tag: 'MalformedEventLog',
      detail: `header does not match the empirical event-log contract: ${formatIssue(header.left)}`,
    }
  }

  const actions: Array<EventLogAction> = []
  const materializations: Array<EventLogMaterialization> = []
  for (const raw of rawRest) {
    const actionRow = Schema.decodeUnknownEither(ActionExecutionRow)(raw)
    if (Either.isRight(actionRow) === true) {
      const ae = actionRow.right.Event.data.SpanEnd.data.ActionExecution
      actions.push({
        cache_class: cacheClassForExecutionKind(ae.execution_kind),
        ...(ae.name?.category === undefined ? {} : { category: ae.name.category }),
        failed: ae.failed,
        ...((): { targetLabel: string } | {} => {
          if (typeof ae.key !== 'object' || ae.key === null || !('owner' in ae.key)) return {}
          const label = targetLabelOf(ae.key.owner)
          return label === undefined ? {} : { targetLabel: label }
        })(),
        ...(ae.wall_time_us === undefined ? {} : { wallTimeUs: ae.wall_time_us }),
      })
      continue
    }
    const materializationRow = Schema.decodeUnknownEither(MaterializationRow)(raw)
    if (Either.isRight(materializationRow) === true) {
      const fm = materializationRow.right.Event.data.SpanEnd.data.FinalMaterialization
      if (fm.path === undefined) {
        materializations.push({})
      } else {
        materializations.push({ path: fm.path })
      }
    }
    // Any other event kind is additive upstream detail: ignored here, retained raw.
  }

  return {
    _tag: 'DecodedEventLog',
    log: {
      actions,
      buckTraceId: header.right.trace_id,
      materializations,
    },
  }
}

/** Decode both tiers at once. Absent artifacts stay absent — no inference. */
export const decodeEvidence = ({
  buildReportText = null,
  eventLogInput = null,
}: {
  readonly buildReportText?: string | null
  readonly eventLogInput?: Uint8Array | string | null
}): DecodedEvidence => ({
  buildReport: buildReportText == null ? null : decodeBuildReport(buildReportText),
  eventLog: eventLogInput == null ? null : decodeEventLog(eventLogInput),
})
