import {
  actionExclusionReason,
  type ActionArtifact,
  type CacheLane,
} from './buck2-action-evidence.ts'
import {
  completeArtifact,
  evaluateWarm99,
  identity,
  type Observation,
} from './buck2-cache-warm99.ts'
import type { OccurrenceEvidenceRecord } from './buck2-occurrence-records.ts'

export const lanes = ['main-reader', 'merge_group', 'pr', 'main-writer'] as const
export const platforms = ['linux', 'darwin', 'unknown'] as const
export type Platform = (typeof platforms)[number]

/** Job IDs, not display names or runner-label substrings, determine platform. */
export const jobPlatforms: Readonly<Record<string, Platform>> = {
  'tested-tree': 'linux',
  'default-ref-policy': 'linux',
  quality: 'linux',
  'pr-buck2-tools': 'linux',
  test: 'linux',
  'test-macos': 'darwin',
  'test-playwright-utils': 'linux',
  'test-playwright-tui-react': 'linux',
  'test-megarepo-cold-gc': 'linux',
  'test-megarepo-store-gc': 'linux',
  'bootstrap-cold-proof': 'linux',
  'devenv-perf': 'linux',
  'nix-closure-sizes': 'linux',
  'main-source-shape': 'linux',
  'ci-measurements-report': 'linux',
  cargo: 'linux',
  weaver: 'linux',
  'pr-a-inert-buck': 'linux',
  'build-products': 'linux',
  'publish-products': 'linux',
  'trusted-buck2-remote-cache-proof': 'linux',
  'source-shape': 'linux',
  'test-integration-notion': 'linux',
  'test-integration-restate': 'linux',
  'test-live-deploy-ci-tools': 'linux',
  'deploy-storybooks': 'linux',
  'publish-compiled-products': 'linux',
  'test-storybook-plays': 'linux',
  'build-storybooks': 'linux',
  'buck2-cache-join': 'linux',
}
export const platformForJob = (job: string | null | undefined): Platform =>
  job === undefined || job === null || Object.hasOwn(jobPlatforms, job) !== true
    ? 'unknown'
    : (jobPlatforms[job] ?? 'unknown')

export type JoinObservation = {
  artifact: ActionArtifact | undefined
  lane: CacheLane
  job?: string
  runId?: string
}
export type JoinEvidenceGap = { lane: CacheLane; job?: string; count?: number }
export type JoinSample = { lane: CacheLane; seen: number; selected: number; artifacts: number }
export type JoinCounts = {
  lane: CacheLane
  platform: Platform
  eligible_actions: number
  remote_hit_actions: number
  avoidable_miss_actions: number
  local_actions: number
  cold_actions: number
  changed_actions: number
  noncacheable_actions: number
  excluded_actions: number
  upload_failure_actions: number
  evidence_gaps: number
}
export type JoinReport = {
  schemaVersion: 1
  repo: string
  window_end_timestamp_seconds: number
  join_artifacts: number
  join_runs: number
  evidence_gaps: number
  unlabelled_evidence_gaps: number
  sampling: readonly JoinSample[]
  counts: JoinCounts[]
}

/**
 * Join trusted, strictly decoded evidence using the warm99 production policy.
 * Incomplete artifacts contribute gaps, never erase independent valid observations.
 * Counts deduplicate identities within each reader artifact, then sum independent readers.
 */
export const aggregate = ({
  repo,
  observations,
  runs,
  artifacts = observations.length,
  windowEndTimestampSeconds,
  evidenceGaps = [],
  unlabelledEvidenceGaps = 0,
  samples = [],
}: {
  repo: string
  observations: readonly JoinObservation[]
  runs: number
  artifacts?: number
  windowEndTimestampSeconds: number
  evidenceGaps?: readonly JoinEvidenceGap[]
  unlabelledEvidenceGaps?: number
  samples?: readonly JoinSample[]
}): JoinReport => {
  const counts: JoinCounts[] = lanes.flatMap((lane) =>
    platforms.map((platform) => ({
      lane,
      platform,
      eligible_actions: 0,
      remote_hit_actions: 0,
      avoidable_miss_actions: 0,
      local_actions: 0,
      cold_actions: 0,
      changed_actions: 0,
      noncacheable_actions: 0,
      excluded_actions: 0,
      upload_failure_actions: 0,
      evidence_gaps: 0,
    })),
  )
  const writers = observations.flatMap(({ artifact }) =>
    artifact !== undefined &&
    artifact.header.metadata.repo === repo &&
    artifact.header.metadata.lane === 'main-writer' &&
    completeArtifact({ artifact, writer: true }) === true
      ? [artifact]
      : [],
  )
  for (const row of counts) {
    const selected = observations.filter(
      ({ artifact, lane, job }) =>
        (artifact === undefined || artifact.header.metadata.lane !== null) &&
        lane === row.lane &&
        platformForJob(artifact?.header.metadata.job ?? job) === row.platform,
    )
    const readers: ActionArtifact[] = []
    for (const { artifact } of selected) {
      if (
        artifact === undefined ||
        artifact.header.metadata.repo !== repo ||
        artifact.header.metadata.lane !== row.lane ||
        completeArtifact({ artifact, writer: false }) !== true
      ) {
        row.evidence_gaps++
      } else {
        readers.push(artifact)
      }
    }
    for (const gap of evidenceGaps) {
      if (gap.lane === row.lane && platformForJob(gap.job) === row.platform)
        row.evidence_gaps += gap.count ?? 1
    }
    if (readers.length === 0) continue
    const reference = ({ artifact, index }: { artifact: ActionArtifact; index: number }) => ({
      lane: artifact.header.metadata.lane ?? row.lane,
      summary: `summary-${index}`,
      actions: `actions-${index}`,
    })
    const seenInvocations = new Set<string>()
    for (const artifact of readers) {
      const ids = artifact.header.invocations.map((invocation) => invocation.buildId)
      const replayed = ids.some((id) => seenInvocations.has(id))
      for (const id of ids) seenInvocations.add(id)
      if (replayed === true) {
        row.evidence_gaps++
        continue
      }
      const observation: Observation = {
        id: 'reader',
        sequence: 0,
        writers: writers.map((writer, index) => reference({ artifact: writer, index })),
        readers: [reference({ artifact, index: 0 })],
        nixSubstitution: { substituted: 0, built: 0 },
      }
      const report = evaluateWarm99({
        manifest: { schemaVersion: 1, enabledLanes: [row.lane], observations: [observation] },
        loaded: [{ observation, writers, readers: [artifact] }],
      })
      const result = report.lanes[0]?.observations[0]
      if (result !== undefined) {
        row.eligible_actions += result.eligible
        row.remote_hit_actions += result.remoteHits
        row.avoidable_miss_actions += result.eligible - result.remoteHits
        row.cold_actions += result.cold
        row.changed_actions += result.changed
        row.noncacheable_actions += result.noncacheable
        row.excluded_actions += result.excluded
        row.upload_failure_actions += result.uploadFailure
        row.evidence_gaps += result.evidenceGap
      }
      const local = new Set<string>()
      for (const action of artifact.actions) {
        if (
          action.commandAction === true &&
          actionExclusionReason(action.category) === null &&
          (action.executionKind === 1 || action.executionKind === 8) &&
          artifact.header.invocations.some(
            (invocation) =>
              invocation.buildId === action.buildId &&
              invocation.freshRoot === true &&
              invocation.cacheReadPolicy !== 'disabled-by-design',
          ) === true
        ) {
          const key = identity(action)
          if (key !== undefined) local.add(key)
        }
      }
      row.local_actions += local.size
    }
  }
  return {
    schemaVersion: 1,
    repo,
    window_end_timestamp_seconds: windowEndTimestampSeconds,
    join_artifacts: artifacts,
    join_runs: runs,
    evidence_gaps: unlabelledEvidenceGaps + counts.reduce((sum, row) => sum + row.evidence_gaps, 0),
    unlabelled_evidence_gaps: unlabelledEvidenceGaps,
    sampling: samples,
    counts,
  }
}

export type OccurrenceCounts = {
  occurrences: number
  localExecutions: number
  remoteExecutions: number
  cacheHits: number
  coalesced: number
  repeatExecutions: number
  /** Null means at least one counted occurrence has no native measurement. */
  durationNs: number | null
  totalBytes: number | null
  unavailableDurationCount: number
  unavailableBytesCount: number
}
export type OccurrenceScorecard = {
  proof: 'known' | 'unknown'
  reasons: string[]
  windowStartMs: number
  windowEndMs: number
  totals: OccurrenceCounts
  perHost: ({ host: string } & OccurrenceCounts)[]
}
const emptyOccurrenceCounts = (): OccurrenceCounts => ({
  occurrences: 0,
  localExecutions: 0,
  remoteExecutions: 0,
  cacheHits: 0,
  coalesced: 0,
  repeatExecutions: 0,
  durationNs: 0,
  totalBytes: 0,
  unavailableDurationCount: 0,
  unavailableBytesCount: 0,
})

const nonempty = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0
const measurement = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) === true && value >= 0 ? value : null
/** Exact completion-window census; callers must declare sampling/retention gaps. */
export const aggregateOccurrences = ({
  artifacts,
  windowStartMs,
  windowEndMs,
  evidenceGaps,
  retainedEvidence,
}: {
  artifacts: readonly ActionArtifact[]
  windowStartMs: number
  windowEndMs: number
  evidenceGaps: readonly string[]
  retainedEvidence?: {
    records: readonly OccurrenceEvidenceRecord[]
    evidenceGaps: readonly string[]
  }
}): OccurrenceScorecard => {
  const reasons = new Set(evidenceGaps)
  if (retainedEvidence !== undefined)
    for (const gap of retainedEvidence.evidenceGaps) reasons.add(gap)
  const validWindow =
    Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs) && windowStartMs < windowEndMs
  if (validWindow !== true) reasons.add('invalid-window')
  type Row = Pick<OccurrenceCounts, 'durationNs' | 'totalBytes'> & {
    id: string
    host: string
    root: string
    build: string
    key: string
    time: number
    outcome: 'local-exec' | 'remote-exec' | 'cache-hit' | 'coalesced'
  }
  const rows = new Map<string, Row>()
  const conflicts = new Set<string>()
  const recordOccurrence = (row: Row) => {
    const previous = rows.get(row.id)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(row)) {
      reasons.add('conflicting-occurrence')
      conflicts.add(row.id)
    } else {
      rows.set(row.id, row)
    }
  }
  for (const artifact of artifacts) {
    const { header } = artifact
    if (
      header.complete !== true ||
      header.status !== 'collected' ||
      header.droppedActionCount !== 0 ||
      header.rows !== artifact.actions.length ||
      header.actionCount !== artifact.actions.length
    )
      reasons.add('incomplete-artifact')
    for (const gap of header.evidenceGaps) reasons.add(gap)
    if (header.missingDigestCount !== 0) reasons.add('missing-digest')
    if (header.missingIdentityCount !== 0) reasons.add('missing-occurrence-identity')
    if (header.missingTimestampCount !== 0) reasons.add('missing-native-time')
    if (nonempty(header.metadata.runId) === false) reasons.add('missing-run')
    if (header.metadata.lane === null) reasons.add('missing-lane')
    if (nonempty(header.metadata.repo) === false) reasons.add('missing-repo')
    for (const invocation of header.invocations) {
      if (invocation.complete !== true) reasons.add('incomplete-invocation')
      if (nonempty(invocation.rootId) === false) reasons.add('missing-root')
    }
    for (const action of artifact.actions) {
      const time = action.completedAt
      if (time === null || Number.isFinite(time) === false) {
        reasons.add('missing-native-time')
        continue
      }
      if (validWindow !== true || time < windowStartMs || time >= windowEndMs) continue
      const invocation = header.invocations.find((entry) => entry.buildId === action.buildId)
      const host = action.host ?? header.metadata.host
      let valid = true
      const requireField = ({ present, reason }: { present: boolean; reason: string }) => {
        if (present !== true) {
          reasons.add(reason)
          valid = false
        }
      }
      requireField({
        present: nonempty(action.occurrenceId),
        reason: 'missing-occurrence-identity',
      })
      requireField({ present: nonempty(action.buildId), reason: 'missing-build-identity' })
      requireField({ present: nonempty(invocation?.rootId), reason: 'missing-root' })
      requireField({ present: nonempty(host), reason: 'missing-host' })
      requireField({ present: nonempty(action.digest), reason: 'missing-digest' })
      requireField({ present: nonempty(action.configuration), reason: 'missing-configuration' })
      requireField({
        present:
          action.startedAt !== null &&
          Number.isFinite(action.startedAt) === true &&
          action.startedAt <= time,
        reason: 'missing-native-time',
      })
      const outcome = action.executionOutcome
      if (outcome === undefined || outcome === 'unknown') {
        reasons.add('missing-execution-outcome')
        continue
      }
      if (outcome === 'remote-exec' || outcome === 'coalesced')
        reasons.add('unlinked-worker-attempt')
      if (
        valid !== true ||
        nonempty(action.occurrenceId) === false ||
        nonempty(action.buildId) === false ||
        nonempty(invocation?.rootId) === false ||
        nonempty(host) === false ||
        nonempty(action.digest) === false
      )
        continue
      recordOccurrence({
        id: action.occurrenceId,
        host,
        root: invocation.rootId,
        build: action.buildId,
        key: action.digest,
        time,
        outcome,
        durationNs: measurement(action.durationNs),
        totalBytes: measurement(action.totalBytes),
      })
    }
  }
  if (retainedEvidence !== undefined)
    for (const record of retainedEvidence.records) {
      const time = record.completedAt
      if (time === null || Number.isFinite(time) === false) {
        reasons.add('missing-native-time')
        continue
      }
      if (validWindow !== true || time < windowStartMs || time >= windowEndMs) continue
      if (nonempty(record.runId) === false) reasons.add('missing-run')
      if (nonempty(record.lane) === false) reasons.add('missing-lane')
      if (
        nonempty(record.id) === false ||
        nonempty(record.buildId) === false ||
        nonempty(record.host) === false ||
        nonempty(record.rootId) === false ||
        nonempty(record.digest) === false
      ) {
        reasons.add('missing-occurrence-identity')
        continue
      }
      if (
        record.startedAt === null ||
        Number.isFinite(record.startedAt) === false ||
        record.startedAt > time
      ) {
        reasons.add('missing-native-time')
        continue
      }
      if (record.executionOutcome === 'failed' || record.executionOutcome === 'unknown') {
        reasons.add('missing-execution-outcome')
        continue
      }
      if (record.executionOutcome === 'remote-exec') reasons.add('unlinked-worker-attempt')
      recordOccurrence({
        id: record.id,
        host: record.host,
        root: record.rootId,
        build: record.buildId,
        key: record.digest,
        time,
        outcome: record.executionOutcome,
        durationNs: measurement(record.durationNs),
        totalBytes: measurement(record.totalBytes),
      })
    }
  const totals = emptyOccurrenceCounts()
  const hosts = new Map<string, OccurrenceCounts>()
  const executed = new Set<string>()
  for (const row of [...rows.values()].toSorted(
    (left, right) => left.time - right.time || left.id.localeCompare(right.id),
  )) {
    if (conflicts.has(row.id) === true) continue
    let host = hosts.get(row.host)
    if (host === undefined) {
      host = emptyOccurrenceCounts()
      hosts.set(row.host, host)
    }
    const execution = row.outcome === 'local-exec' || row.outcome === 'remote-exec'
    const repeat = execution && executed.has(row.key)
    if (execution === true) executed.add(row.key)
    for (const counts of [totals, host]) {
      counts.occurrences++
      if (row.outcome === 'local-exec') counts.localExecutions++
      if (row.outcome === 'remote-exec') counts.remoteExecutions++
      if (row.outcome === 'cache-hit') counts.cacheHits++
      if (row.outcome === 'coalesced') counts.coalesced++
      if (repeat === true) counts.repeatExecutions++
      for (const [key, unavailable, overflow] of [
        ['durationNs', 'unavailableDurationCount', 'duration-total-overflow'],
        ['totalBytes', 'unavailableBytesCount', 'byte-total-overflow'],
      ] as const) {
        const value = row[key]
        const current = counts[key]
        if (value === null) {
          counts[unavailable]++
          counts[key] = null
        } else if (current !== null) {
          const sum = current + value
          counts[key] = Number.isSafeInteger(sum) === true ? sum : null
          if (counts[key] === null) reasons.add(overflow)
        }
      }
    }
  }
  return {
    proof: reasons.size === 0 ? 'known' : 'unknown',
    reasons: [...reasons].toSorted(),
    windowStartMs,
    windowEndMs,
    totals,
    perHost: [...hosts]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([host, counts]) => Object.assign({ host }, counts)),
  }
}

type MetricPoint = { labels: Record<string, string>; value: number }
type WindowMetric = { name: string; description: string; points: MetricPoint[] }
const metrics = (report: JoinReport): WindowMetric[] => [
  ...(
    [
      'eligible_actions',
      'remote_hit_actions',
      'avoidable_miss_actions',
      'local_actions',
      'cold_actions',
      'changed_actions',
      'noncacheable_actions',
      'excluded_actions',
      'upload_failure_actions',
      'evidence_gaps',
    ] as const
  ).map((key) => ({
    name: `buck2.cache.lane.${key}`,
    description:
      key === 'eligible_actions'
        ? 'Window exact action identities observed by complete trusted main writers before reader invocation start, by cache lane and platform.'
        : key === 'excluded_actions'
          ? 'Window policy-excluded actions, deliberate cache-read-disabled controls and nonfresh repetitions by cache lane and platform.'
          : `Window ${key.replaceAll('_', ' ')} by cache lane and platform.`,
    points: report.counts.map((row) => ({
      labels: { repo: report.repo, lane: row.lane, platform: row.platform },
      value: row[key],
    })),
  })),
  ...(
    [
      ['artifacts', report.join_artifacts],
      ['runs', report.join_runs],
      ['window_end_timestamp_seconds', report.window_end_timestamp_seconds],
      ['evidence_gaps', report.unlabelled_evidence_gaps],
    ] as const
  ).map(([key, value]) => ({
    name: `buck2.cache.join.${key}`,
    description: `Window join ${key.replaceAll('_', ' ')}.`,
    points: [{ labels: { repo: report.repo }, value }],
  })),
  ...(
    [
      ['runs_seen', 'seen'],
      ['runs_selected', 'selected'],
      ['artifacts_selected', 'artifacts'],
    ] as const
  ).map(([name, key]) => ({
    name: `buck2.cache.join.${name}`,
    description: `Window join ${name.replaceAll('_', ' ')} by cache lane.`,
    points: report.sampling.map((sample) => ({
      labels: { repo: report.repo, lane: sample.lane },
      value: sample[key],
    })),
  })),
]
const escapeLabel = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')

/** Prometheus gauges describe one bounded window, not process-lifetime counters. */
export const renderPrometheus = (report: JoinReport): string => {
  const lines: string[] = []
  for (const metric of metrics(report)) {
    const name = metric.name.replaceAll('.', '_')
    lines.push(`# HELP ${name} ${metric.description}`, `# TYPE ${name} gauge`)
    for (const { labels, value } of metric.points) {
      const dimensions = Object.entries(labels)
        .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
        .join(',')
      lines.push(`${name}{${dimensions}} ${value} ${report.window_end_timestamp_seconds * 1000}`)
    }
  }
  return `${lines.join('\n')}\n`
}

type OtlpAttribute = { key: string; value: { stringValue: string } }
export type OtlpChunk = {
  resourceMetrics: {
    resource: { attributes: OtlpAttribute[] }
    scopeMetrics: {
      scope: { name: string }
      metrics: {
        name: string
        description: string
        unit: string
        gauge: {
          dataPoints: {
            attributes: OtlpAttribute[]
            timeUnixNano: string
            asDouble: number
          }[]
        }
      }[]
    }[]
  }[]
}

const attributes = (labels: Record<string, string>): OtlpAttribute[] =>
  Object.entries(labels).map(([key, stringValue]) => ({ key, value: { stringValue } }))
/** OTLP JSON gauge payload; the CLI owns spool publication, not this pure renderer. */
export const renderOtlp = (report: JoinReport): OtlpChunk => {
  const timeUnixNano = BigInt(Math.round(report.window_end_timestamp_seconds * 1e9)).toString()
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: attributes({
            'service.name': 'effect-utils-buck2',
            'service.namespace': 'infra',
          }),
        },
        scopeMetrics: [
          {
            scope: { name: 'buck2-cache-join' },
            metrics: metrics(report).map((metric) => ({
              name: metric.name,
              description: metric.description,
              unit: metric.name.endsWith('_seconds') === true ? 's' : '1',
              gauge: {
                dataPoints: metric.points.map(({ labels, value }) => ({
                  attributes: attributes(labels),
                  timeUnixNano,
                  asDouble: value,
                })),
              },
            })),
          },
        ],
      },
    ],
  }
}

/**
 * Daily window gauges for the occurrence census, including partial observations.
 * Only host is a point dimension: proof gates exactness, not row availability.
 */
export const renderOccurrenceOtlp = (scorecard: OccurrenceScorecard): OtlpChunk => {
  const timeUnixNano = BigInt(Math.round(scorecard.windowEndMs * 1e6)).toString()
  const definitions = [
    ['occurrences', 'occurrences', '1'],
    ['local_executions', 'localExecutions', '1'],
    ['remote_executions', 'remoteExecutions', '1'],
    ['cache_hits', 'cacheHits', '1'],
    ['coalesced', 'coalesced', '1'],
    ['repeat_executions', 'repeatExecutions', '1'],
    ['duration_ns', 'durationNs', 'ns'],
    ['output_bytes', 'totalBytes', 'By'],
    ['unavailable_duration_count', 'unavailableDurationCount', '1'],
    ['unavailable_bytes_count', 'unavailableBytesCount', '1'],
  ] as const
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'effect-utils-buck2' } },
            { key: 'service.namespace', value: { stringValue: 'infra' } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'buck2-cache-join' },
            metrics: [
              {
                name: 'buck2.cache.execute_once.proof_known',
                description:
                  'One when the entire occurrence window is exact; zero for incomplete evidence.',
                unit: '1',
                gauge: {
                  dataPoints: [
                    {
                      attributes: [],
                      timeUnixNano,
                      asDouble: scorecard.proof === 'known' ? 1 : 0,
                    },
                  ],
                },
              },
              ...definitions.map(([name, key, unit]) => ({
                name: `buck2.cache.execute_once.${name}`,
                description: `Observed window ${name.replaceAll('_', ' ')} by native host; consult proof_known for exactness.`,
                unit,
                gauge: {
                  dataPoints: scorecard.perHost.flatMap((row) => {
                    const value = row[key]
                    return value === null
                      ? []
                      : [
                          {
                            attributes: [{ key: 'host', value: { stringValue: row.host } }],
                            timeUnixNano,
                            asDouble: value,
                          },
                        ]
                  }),
                },
              })),
            ],
          },
        ],
      },
    ],
  }
}

/** Previous complete UTC day, in Unix milliseconds; `until` is exclusive. */
export const previousUtcDay = (now: number): { since: number; until: number } => {
  const until = Math.floor(now / 86_400_000) * 86_400_000
  return { since: until - 86_400_000, until }
}
