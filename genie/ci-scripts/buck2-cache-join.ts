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

export const lanes = ['main-reader', 'merge_group', 'pr', 'main-writer'] as const
export const platforms = ['linux', 'darwin', 'unknown'] as const
export type Platform = (typeof platforms)[number]

/** Job IDs, not display names or runner-label substrings, determine platform. */
export const jobPlatforms: Readonly<Record<string, Platform>> = {
  'tested-tree': 'linux',
  'default-ref-policy': 'linux',
  quality: 'linux',
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
    const reference = (artifact: ActionArtifact, index: number) => ({
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
        writers: writers.map(reference),
        readers: [reference(artifact, 0)],
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
          )
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
    description: `Window ${key.replaceAll('_', ' ')} by cache lane and platform.`,
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
export const renderPrometheus = (report: JoinReport): string =>
  `${metrics(report)
    .flatMap((metric) => {
      const name = metric.name.replaceAll('.', '_')
      return [
        `# HELP ${name} ${metric.description}`,
        `# TYPE ${name} gauge`,
        ...metric.points.map(
          ({ labels, value }) =>
            `${name}{${Object.entries(labels)
              .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
              .join(',')}} ${value} ${report.window_end_timestamp_seconds * 1000}`,
        ),
      ]
    })
    .join('\n')}\n`

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

/** OTLP JSON gauge payload; the CLI owns spool publication, not this pure renderer. */
export const renderOtlp = (report: JoinReport): OtlpChunk => {
  const attributes = (labels: Record<string, string>): OtlpAttribute[] =>
    Object.entries(labels).map(([key, stringValue]) => ({ key, value: { stringValue } }))
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
              unit: metric.name.endsWith('_seconds') ? 's' : '1',
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

/** Previous complete UTC day, in Unix milliseconds; `until` is exclusive. */
export const previousUtcDay = (now: number): { since: number; until: number } => {
  const until = Math.floor(now / 86_400_000) * 86_400_000
  return { since: until - 86_400_000, until }
}
