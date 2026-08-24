/**
 * Verdict evaluation (spec "Verdicts", BUCK.OBS-R03 / BUCK.OBS-R11).
 *
 * - Missing required evidence yields NO_VERDICT — consumer admission may hold,
 *   but the recorded Buck result is never changed by this module.
 * - An unsupported event-log version degrades ONLY the rich claims to
 *   NO_VERDICT while stable evidence remains available.
 * - PASS/FAIL require the evidence the predicate reads to have been observed
 *   and decoded; no exact cause may be inferred without causal proof.
 */
import type { DecodedEvidence, NoVerdictCause, StableBuildReport, Verdict } from './model.ts'

const stableCauseFor = (evidence: DecodedEvidence): NoVerdictCause | null => {
  if (evidence.buildReport == null) return 'missing-build-report'
  if (evidence.buildReport._tag === 'Malformed') return 'malformed-build-report'
  return null
}

const richCauseFor = (evidence: DecodedEvidence): NoVerdictCause | null => {
  if (evidence.eventLog == null) return 'missing-event-log'
  if (evidence.eventLog._tag === 'MalformedEventLog') return 'malformed-event-log'
  if (evidence.eventLog._tag === 'UnsupportedEventLogVersion') {
    return 'unsupported-event-log-version'
  }
  return null
}

/**
 * Combined verdict across both tiers. When `predicate` is supplied it receives
 * the decoded stable report and decides PASS/FAIL itself; otherwise the default
 * predicate holds iff the report's aggregate outcome is exactly `'SUCCESS'`.
 *
 * A present-but-unusable tier wins over PASS/FAIL: the combined verification
 * verdict is explicitly NO_VERDICT with that tier's cause, while the stable
 * claims themselves stay decodable for callers that want them.
 */
export const verdictFor = ({
  evidence,
  predicate,
}: {
  readonly evidence: DecodedEvidence
  readonly predicate?: (report: StableBuildReport) => boolean | undefined
}): Verdict => {
  const stableCause = stableCauseFor(evidence)
  if (stableCause !== null) {
    return { _tag: 'NO_VERDICT', cause: stableCause }
  }
  const richCause = richCauseFor(evidence)
  if (richCause !== null) {
    return { _tag: 'NO_VERDICT', cause: richCause }
  }
  const report = (evidence.buildReport as { _tag: 'Decoded'; report: StableBuildReport }).report
  const held =
    predicate === undefined ? report.outcome === 'SUCCESS' : predicate(report) === true
  return held === true
    ? { _tag: 'PASS' }
    : { _tag: 'FAIL', reason: 'stable build-report predicate did not hold' }
}

/**
 * Rich-tier guard for consumers that need action/cache/materialization detail:
 * true only when the event log was present AND admitted. Never throws, so a
 * caller can hold admission without corrupting the recorded Buck result.
 */
export const richClaimsAvailable = (evidence: DecodedEvidence): boolean =>
  evidence.eventLog !== null && evidence.eventLog._tag === 'DecodedEventLog'
