/**
 * The two-tier evidence decoder (spec "Evidence Adapter").
 *
 * Pure string-in/result-out: file IO and retention belong to the calling
 * control plane (BUCK.OBS-R01), so the decoder stays trivially testable and
 * can never rewrite execution truth — it only projects typed views onto it.
 *
 * Tier 1 decodes the stable build report additively. Tier 2 admits only the
 * event-log shapes listed in {@link AdmittedEventLogVersions}; an unknown
 * version is retained as raw evidence and marked unsupported for rich
 * interpretation (BUCK.OBS-R03, BUCK.OBS-T01). `what-ran`/`what-materialized`
 * summaries are NOT consulted here: they derive from the event log and are
 * therefore never more authoritative than it.
 */
import { Either, ParseResult, Schema } from 'effect'

import {
  AdmittedEventLogVersions,
  type AdmittedEventLogVersion,
  type EventLogAction,
  EventLogHeader,
  EventLogLine,
  type EventLogMaterialization,
  StableBuildReport,
  type BuildReportResult,
  type DecodedEvidence,
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

/**
 * Tier 1: additive-tolerant decode of a build report's stable fields.
 * Unknown upstream properties are ignored; missing ones stay absent.
 */
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
    onLeft: (issue) => ({ _tag: 'Malformed', detail: formatIssue(issue) }),
    // The const schemas are structural mirrors of the interfaces above.
    onRight: (report) => ({ _tag: 'Decoded', report: report as StableBuildReport }),
  })
}

interface ParsedEventLogLine {
  readonly payload: unknown
  readonly type: string
}

/** Tier 2: version-bound event-log decode (see module doc for the admitted contract). */
export const decodeEventLog = (text: string): EventLogResult => {
  if (text.trim() === '') {
    return { _tag: 'MalformedEventLog', detail: 'event log is empty' }
  }

  let rawLines: ReadonlyArray<ParsedEventLogLine>
  try {
    rawLines = text
      .split('\n')
      .flatMap((line) =>
        line.trim() === '' ? [] : [(JSON.parse(line) as ParsedEventLogLine)],
      )
  } catch (cause) {
    return { _tag: 'MalformedEventLog', detail: `invalid JSON line: ${String(cause)}` }
  }

  const [rawHeader, ...rawRest] = rawLines
  if (rawHeader === undefined) {
    return { _tag: 'MalformedEventLog', detail: 'event log has no header line' }
  }
  const header = Schema.decodeUnknownEither(EventLogHeader)(rawHeader)
  if (Either.isLeft(header) === true) {
    return {
      _tag: 'MalformedEventLog',
      detail: `header does not match buck2.event-log/v1 contract: ${formatIssue(header.left)}`,
    }
  }
  if (AdmittedEventLogVersions.includes(header.right.buck_version as never) === false) {
    // Unknown pin: retain the raw file untouched (caller's retention policy)
    // and refuse rich interpretation — no guessing at the shape (R03).
    return {
      _tag: 'UnsupportedEventLogVersion',
      buckVersion: header.right.buck_version as AdmittedEventLogVersion,
    }
  }

  const actions: Array<EventLogAction> = []
  const materializations: Array<EventLogMaterialization> = []
  for (const [index, raw] of rawRest.entries()) {
    const decoded = Schema.decodeUnknownEither(EventLogLine)(raw)
    if (Either.isLeft(decoded) === true) {
      return {
        _tag: 'MalformedEventLog',
        detail: `line ${index + 2}: ${formatIssue(decoded.left)}`,
      }
    }
    if (decoded.right.type === 'action_ended') {
      actions.push(decoded.right.payload as EventLogAction)
    } else {
      materializations.push(decoded.right.payload as EventLogMaterialization)
    }
  }

  return {
    _tag: 'DecodedEventLog',
    log: {
      actions,
      buckVersion: header.right.buck_version as AdmittedEventLogVersion,
      formatVersion: 1,
      invocationId: header.right.invocation_id,
      materializations,
    },
  }
}

/** Decode both tiers at once. Absent artifacts stay absent — no inference. */
export const decodeEvidence = ({
  buildReportText = null,
  eventLogText = null,
}: {
  readonly buildReportText?: string | null
  readonly eventLogText?: string | null
}): DecodedEvidence => ({
  buildReport: buildReportText == null ? null : decodeBuildReport(buildReportText),
  eventLog: eventLogText == null ? null : decodeEventLog(eventLogText),
})
