import { boolean, integer, text } from './buck2-action-evidence-codec.ts'
import {
  actionKeys,
  attr,
  attributes,
  decodeOccurrenceFiles,
  fail,
  get,
  milliseconds,
  ns,
  safe,
  type Capture,
  type Census,
  type RetainedOccurrenceFile,
} from './buck2-occurrence-record-codec.ts'

export interface OccurrenceEvidenceRecord {
  id: string
  buildId: string
  rootId: string | null
  host: string
  runId: string | null
  lane: string | null
  digest: string | null
  startedAt: number | null
  completedAt: number | null
  executionOutcome: 'local-exec' | 'cache-hit' | 'remote-exec' | 'failed' | 'unknown'
  durationNs: number | null
  totalBytes: number | null
}
export interface OccurrenceEvidence {
  records: OccurrenceEvidenceRecord[]
  evidenceGaps: string[]
}
export interface OccurrenceRecordsInput {
  files: readonly RetainedOccurrenceFile[]
  expectedHosts: readonly string[]
  windowStartMs: number
  windowEndMs: number
}

/** Pure v1 boundary. Enrollment is not a continuous fleet census or worker linkage. */
export const reconcileOccurrenceRecords = ({
  files,
  expectedHosts,
  windowStartMs,
  windowEndMs,
}: OccurrenceRecordsInput): OccurrenceEvidence => {
  const gaps = new Set<string>([
    'unsupported-entrypoints:unknown',
    'fleet-registry:unknown',
    'continuous-census:unknown',
    'remote-worker-linkage:unknown',
  ])
  const records: OccurrenceEvidenceRecord[] = []
  const start = BigInt(integer(windowStartMs)) * 1_000_000n
  const end = BigInt(integer(windowEndMs)) * 1_000_000n
  if (end <= start) fail()
  const hosts = new Set(expectedHosts.map(text))
  if (hosts.size === 0) gaps.add('expected-hosts:missing')
  const { manifests, census, captures } = decodeOccurrenceFiles({ files, hosts, start, gaps })
  for (const host of hosts) if (manifests.has(host) === false) gaps.add(`${host}:missing-manifest`)
  const buildCensus = new Map<string, Census>()
  for (const entry of census.values()) {
    if (hosts.has(entry.host) === false) gaps.add(`${entry.host}:unexpected-host`)
    if (entry.error === true) gaps.add(`${entry.id}:capture-error`)
    const other = census.get(
      JSON.stringify([entry.id, entry.phase === 'open' ? 'terminal' : 'open']),
    )
    if (other === undefined)
      gaps.add(`${entry.id}:missing-${entry.phase === 'open' ? 'terminal' : 'open'}`)
    else if (
      other.host !== entry.host ||
      other.run !== entry.run ||
      other.lane !== entry.lane ||
      (entry.phase === 'terminal' &&
        (entry.at < other.at || (other.build !== null && other.build !== entry.build)))
    )
      gaps.add(`${entry.id}:census-identity-mismatch`)
    if (entry.phase === 'terminal') {
      if (entry.build === null) gaps.add(`${entry.id}:missing-build`)
      else {
        if (buildCensus.has(entry.build) === true && buildCensus.get(entry.build)?.id !== entry.id)
          gaps.add(`${entry.build}:multiple-invocations`)
        buildCensus.set(entry.build, entry)
        if (captures.has(entry.build) === false) gaps.add(`${entry.id}:missing-conversion`)
      }
    }
  }
  const observed = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const [build, versions] of captures) {
    const terminal = buildCensus.get(build)
    if (terminal === undefined) gaps.add(`${build}:missing-census`)
    const merged = new Map<string, { value: unknown; capture: Capture; canonical: string }>()
    const complete = versions.filter((version) => version.incomplete === false)
    for (const capture of versions) {
      for (const span of capture.conflicts) conflicted.add(JSON.stringify([build, span]))
      if (
        versions.some(
          (other) =>
            other.root !== capture.root ||
            JSON.stringify(Array.from(other.attrs).toSorted()) !==
              JSON.stringify(Array.from(capture.attrs).toSorted()),
        ) === true
      )
        gaps.add(`${build}:capture-identity-mismatch`)
      if (
        capture.incomplete === true &&
        complete.some(
          (candidate) =>
            capture.root === candidate.root &&
            JSON.stringify(Array.from(capture.attrs).toSorted()) ===
              JSON.stringify(Array.from(candidate.attrs).toSorted()) &&
            Array.from(capture.rows).every(
              ([span, canonical]) => candidate.rows.get(span) === canonical,
            ),
        ) === false
      )
        gaps.add(`${build}:incomplete-conversion`)
      if (
        versions.some(
          (other) =>
            Array.from(capture.rows).every(
              ([span, canonical]) => other.rows.get(span) === canonical,
            ) === false &&
            Array.from(other.rows).every(
              ([span, canonical]) => capture.rows.get(span) === canonical,
            ) === false,
        ) === true
      )
        gaps.add(`${build}:incomparable-captures`)
      for (const [span, canonical] of capture.rows) {
        const prior = merged.get(span)
        if (
          prior !== undefined &&
          (prior.canonical !== canonical ||
            prior.capture.root !== capture.root ||
            JSON.stringify(Array.from(prior.capture.attrs).toSorted()) !==
              JSON.stringify(Array.from(capture.attrs).toSorted()))
        ) {
          gaps.add(`${build}:${span}:conflicting-capture`)
          conflicted.add(JSON.stringify([build, span]))
        }
        merged.set(span, { value: capture.values.get(span), capture, canonical })
      }
    }
    for (const [span, { value, capture }] of merged) {
      if (conflicted.has(JSON.stringify([build, span])) === true) continue
      const read = get(value)
      const attrs = attributes({ value: read('attributes'), keys: actionKeys })
      const resource = attr(capture.attrs)
      const action = attr(attrs)
      const id = action('buck2.occurrence_id')
      const host = resource('host.name')
      if (id === null || host === null) {
        gaps.add(`${build}:${span}:missing-identity`)
        continue
      }
      if (hosts.has(host) === false) gaps.add(`${host}:unexpected-host`)
      const run = resource('cicd.pipeline.run.id')
      if (
        terminal !== undefined &&
        (terminal.host !== host || (run !== null && terminal.run !== run))
      )
        gaps.add(`${build}:capture-census-mismatch`)
      if (resource('buck2.root_id') !== null && capture.root !== resource('buck2.root_id'))
        gaps.add(`${build}:root-mismatch`)
      const started = ns(read('start_ns'))
      const ended = ns(read('end_ns'))
      const closed =
        boolean(read('ended')) === true && attrs.get('buck2.unclosed') !== true && ended >= started
      if (closed === false) {
        gaps.add(`${id}:unclosed`)
        continue
      }
      if (ended < start || ended >= end) continue
      const rawOutcome = action('buck2.execution_outcome')
      const outcome = attrs.get('buck2.failed') === true ? 'failed' : rawOutcome
      if (
        outcome !== 'local-exec' &&
        outcome !== 'cache-hit' &&
        outcome !== 'remote-exec' &&
        outcome !== 'failed' &&
        outcome !== 'unknown' &&
        outcome !== null
      ) {
        gaps.add(`${id}:unknown-outcome`)
        continue
      }
      const bytes = action('buck2.total_bytes')
      const record: OccurrenceEvidenceRecord = {
        id,
        buildId: build,
        rootId: capture.root,
        host,
        runId: run ?? terminal?.run ?? null,
        lane: terminal?.lane ?? null,
        digest: action('buck2.action_digest'),
        startedAt: milliseconds(started),
        completedAt: milliseconds(ended),
        executionOutcome: outcome ?? 'unknown',
        durationNs: safe(ended - started),
        totalBytes: bytes === null ? null : safe(BigInt(bytes)),
      }
      for (const key of [
        'rootId',
        'runId',
        'lane',
        'digest',
        'startedAt',
        'completedAt',
        'durationNs',
        'totalBytes',
      ] satisfies readonly (keyof OccurrenceEvidenceRecord)[])
        if (record[key] === null) gaps.add(`${id}:missing-${key}`)
      if (record.executionOutcome === 'unknown') gaps.add(`${id}:unknown-outcome`)
      const canonical = JSON.stringify(record)
      const previous = observed.get(id)
      if (previous !== undefined && previous !== canonical) {
        gaps.add(`${id}:conflicting-identity`)
        conflicted.add(id)
      }
      if (previous === undefined) records.push(record)
      observed.set(id, canonical)
    }
  }
  return {
    records: records.filter((record) => conflicted.has(record.id) === false),
    evidenceGaps: Array.from(gaps).toSorted(),
  }
}
