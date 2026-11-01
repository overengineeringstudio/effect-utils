import { describe, expect, it } from 'bun:test'

import type { ActionArtifact, CacheLane } from './buck2-action-evidence.ts'
import {
  aggregate,
  previousUtcDay,
  platformForJob,
  renderOtlp,
  renderPrometheus,
  type JoinObservation,
  type JoinSample,
} from './buck2-cache-join.ts'
import {
  actionFixture,
  artifactFixture,
  encodedFixture,
  writerFixture,
} from './buck2-cache-warm99.fixtures.ts'
import { decodeEvidence } from './buck2-cache-warm99.ts'

const decoded = (artifact: ActionArtifact): ActionArtifact => {
  const { compressed, summary } = encodedFixture(artifact)
  return decodeEvidence({
    compressed,
    summary,
    expectedLane: artifact.header.metadata.lane ?? 'pr',
  })
}
const observation = (
  artifact: ActionArtifact,
  lane: CacheLane = 'main-reader',
  job = 'test',
): JoinObservation => {
  artifact.header.metadata.lane = lane
  artifact.header.metadata.job = job
  artifact.header.metadata.posture = lane === 'main-writer' ? 'writer' : 'read-only'
  return { artifact: decoded(artifact), lane, job }
}
const reportFor = (observations: JoinObservation[]) =>
  aggregate({ repo: 'public/test', observations, runs: 5, windowEndTimestampSeconds: 1000 })

// All timestamps and actions come from warm99's production-contract fixtures.
describe('cache join', () => {
  it('discovers the lane through the strict decoder and retains explicit lane validation', () => {
    const artifact = artifactFixture()
    const { compressed, summary } = encodedFixture(artifact)
    expect(decodeEvidence({ compressed, summary }).header.metadata.lane).toBe('main-reader')
    expect(() => decodeEvidence({ compressed, summary, expectedLane: 'pr' })).toThrow()
  })

  it('ignores deliberately unassigned lane artifacts instead of inventing gaps', () => {
    const artifact = artifactFixture()
    artifact.header.metadata.lane = null
    const { compressed, summary } = encodedFixture(artifact)
    const report = reportFor([{ artifact: decodeEvidence({ compressed, summary }), lane: 'pr' }])
    expect(report.evidence_gaps).toBe(0)
    expect(report.counts.every((row) => row.eligible_actions === 0)).toBe(true)
  })

  it('joins exact identities only after an earlier successful writer upload', () => {
    for (const [uploadedAt, eligible] of [
      [199, 1],
      [200, 0],
      [201, 0],
    ] as const) {
      const writer = writerFixture()
      const action = writer.actions[0]
      if (action !== undefined) {
        action.completedAt = uploadedAt
        action.endTime = uploadedAt
        action.uploadCompletedAt = uploadedAt
      }
      const report = reportFor([observation(writer, 'main-writer'), observation(artifactFixture())])
      expect(
        report.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
      ).toMatchObject({
        eligible_actions: eligible,
        remote_hit_actions: eligible,
        cold_actions: 1 - eligible,
      })
    }
  })

  it('counts absent writer evidence as a gap and keeps the reader cold', () => {
    const report = reportFor([
      { artifact: undefined, lane: 'main-writer', job: 'test' },
      observation(artifactFixture()),
    ])
    expect(report.evidence_gaps).toBe(1)
    expect(
      report.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
    ).toMatchObject({ eligible_actions: 0, remote_hit_actions: 0, cold_actions: 1 })
  })

  it('accepts merge queue writers but not PR uploads or changed digests', () => {
    const queue = writerFixture()
    queue.header.metadata.lane = 'merge_group'
    queue.header.metadata.job = 'test'
    const pr = writerFixture()
    const changed = artifactFixture(false, [actionFixture({ digest: 'feedbeef:12' })])
    const report = reportFor([
      { artifact: decoded(queue), lane: 'merge_group' },
      observation(pr, 'pr'),
      observation(artifactFixture()),
      observation(changed),
    ])
    expect(
      report.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
    ).toMatchObject({
      eligible_actions: 1,
      remote_hit_actions: 1,
      cold_actions: 0,
      changed_actions: 1,
    })
    const withoutQueue = reportFor([
      observation(writerFixture(), 'pr'),
      observation(artifactFixture()),
    ])
    expect(
      withoutQueue.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
    ).toMatchObject({ eligible_actions: 0, cold_actions: 1 })
  })

  it('retains valid counts alongside incomplete evidence, exclusions and unknown jobs', () => {
    const broken = artifactFixture()
    broken.header.complete = false
    broken.header.evidenceGaps = ['missing-log']
    const excluded = actionFixture({ category: 'pnpm_extract' })
    const report = aggregate({
      repo: 'public/test',
      runs: 8,
      artifacts: 9,
      windowEndTimestampSeconds: 1000,
      unlabelledEvidenceGaps: 2,
      observations: [
        observation(writerFixture(), 'main-writer'),
        observation(artifactFixture()),
        observation(artifactFixture(false, [actionFixture({ executionKind: 1 }), excluded])),
        observation(artifactFixture(), 'merge_group', 'test-macos'),
        observation(artifactFixture(), 'pr', 'future-linux-job'),
        { artifact: broken, lane: 'main-reader', job: 'test' },
      ],
    })
    expect(report.counts.filter((row) => row.eligible_actions > 0 || row.evidence_gaps > 0))
      .toMatchInlineSnapshot(`
        [
          {
            "avoidable_miss_actions": 1,
            "changed_actions": 0,
            "cold_actions": 0,
            "eligible_actions": 2,
            "evidence_gaps": 1,
            "excluded_actions": 1,
            "lane": "main-reader",
            "local_actions": 1,
            "noncacheable_actions": 0,
            "platform": "linux",
            "remote_hit_actions": 1,
            "upload_failure_actions": 0,
          },
          {
            "avoidable_miss_actions": 0,
            "changed_actions": 0,
            "cold_actions": 0,
            "eligible_actions": 1,
            "evidence_gaps": 0,
            "excluded_actions": 0,
            "lane": "merge_group",
            "local_actions": 0,
            "noncacheable_actions": 0,
            "platform": "darwin",
            "remote_hit_actions": 1,
            "upload_failure_actions": 0,
          },
          {
            "avoidable_miss_actions": 0,
            "changed_actions": 0,
            "cold_actions": 0,
            "eligible_actions": 1,
            "evidence_gaps": 0,
            "excluded_actions": 0,
            "lane": "pr",
            "local_actions": 0,
            "noncacheable_actions": 0,
            "platform": "unknown",
            "remote_hit_actions": 1,
            "upload_failure_actions": 0,
          },
        ]
      `)
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      schemaVersion: 1,
      repo: 'public/test',
      join_runs: 8,
      join_artifacts: 9,
      evidence_gaps: 3,
      unlabelled_evidence_gaps: 2,
      window_end_timestamp_seconds: 1000,
    })
    expect(report.counts).toHaveLength(12)
  })

  it('counts independent fresh invocations instead of deduplicating an identity across the day', () => {
    const report = reportFor([
      observation(writerFixture(), 'main-writer'),
      observation(artifactFixture()),
      observation(artifactFixture()),
    ])
    expect(
      report.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
    ).toMatchObject({ eligible_actions: 2, remote_hit_actions: 2, avoidable_miss_actions: 0 })
  })

  it('does not borrow uploads from another repository or a replayed invocation', () => {
    const writer = writerFixture()
    writer.header.metadata.repo = 'other/repo'
    const reader = observation(artifactFixture())
    const report = reportFor([observation(writer, 'main-writer'), reader, reader])
    expect(
      report.counts.find((row) => row.lane === 'main-reader' && row.platform === 'linux'),
    ).toMatchObject({ eligible_actions: 0, cold_actions: 1, evidence_gaps: 1 })
  })

  it('uses explicit job mappings rather than guessing platform from names', () => {
    expect(platformForJob('test')).toBe('linux')
    expect(platformForJob('test-macos')).toBe('darwin')
    expect(platformForJob('unknown-linux')).toBe('unknown')
    expect(platformForJob(undefined)).toBe('unknown')
    expect(platformForJob('publish-compiled-products')).toBe('linux')
    expect(platformForJob('toString')).toBe('unknown')
    expect(platformForJob('__proto__')).toBe('unknown')
  })

  it('renders closed labels and window gauges without action identifiers', () => {
    const report = reportFor([
      observation(writerFixture(), 'main-writer'),
      observation(artifactFixture()),
    ])
    expect(
      renderPrometheus({
        ...report,
        counts: report.counts.filter(
          (row) => row.lane === 'main-reader' && row.platform === 'linux',
        ),
      }),
    ).toMatchInlineSnapshot(`
        "# HELP buck2_cache_lane_eligible_actions Window eligible actions by cache lane and platform.
        # TYPE buck2_cache_lane_eligible_actions gauge
        buck2_cache_lane_eligible_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 1 1000000
        # HELP buck2_cache_lane_remote_hit_actions Window remote hit actions by cache lane and platform.
        # TYPE buck2_cache_lane_remote_hit_actions gauge
        buck2_cache_lane_remote_hit_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 1 1000000
        # HELP buck2_cache_lane_avoidable_miss_actions Window avoidable miss actions by cache lane and platform.
        # TYPE buck2_cache_lane_avoidable_miss_actions gauge
        buck2_cache_lane_avoidable_miss_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_local_actions Window local actions by cache lane and platform.
        # TYPE buck2_cache_lane_local_actions gauge
        buck2_cache_lane_local_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_cold_actions Window cold actions by cache lane and platform.
        # TYPE buck2_cache_lane_cold_actions gauge
        buck2_cache_lane_cold_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_changed_actions Window changed actions by cache lane and platform.
        # TYPE buck2_cache_lane_changed_actions gauge
        buck2_cache_lane_changed_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_noncacheable_actions Window noncacheable actions by cache lane and platform.
        # TYPE buck2_cache_lane_noncacheable_actions gauge
        buck2_cache_lane_noncacheable_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_excluded_actions Window excluded actions by cache lane and platform.
        # TYPE buck2_cache_lane_excluded_actions gauge
        buck2_cache_lane_excluded_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_upload_failure_actions Window upload failure actions by cache lane and platform.
        # TYPE buck2_cache_lane_upload_failure_actions gauge
        buck2_cache_lane_upload_failure_actions{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_lane_evidence_gaps Window evidence gaps by cache lane and platform.
        # TYPE buck2_cache_lane_evidence_gaps gauge
        buck2_cache_lane_evidence_gaps{repo=\"public/test\",lane=\"main-reader\",platform=\"linux\"} 0 1000000
        # HELP buck2_cache_join_artifacts Window join artifacts.
        # TYPE buck2_cache_join_artifacts gauge
        buck2_cache_join_artifacts{repo=\"public/test\"} 2 1000000
        # HELP buck2_cache_join_runs Window join runs.
        # TYPE buck2_cache_join_runs gauge
        buck2_cache_join_runs{repo=\"public/test\"} 5 1000000
        # HELP buck2_cache_join_window_end_timestamp_seconds Window join window end timestamp seconds.
        # TYPE buck2_cache_join_window_end_timestamp_seconds gauge
        buck2_cache_join_window_end_timestamp_seconds{repo=\"public/test\"} 1000 1000000
        # HELP buck2_cache_join_evidence_gaps Window join evidence gaps.
        # TYPE buck2_cache_join_evidence_gaps gauge
        buck2_cache_join_evidence_gaps{repo=\"public/test\"} 0 1000000
        # HELP buck2_cache_join_runs_seen Window join runs seen by cache lane.
        # TYPE buck2_cache_join_runs_seen gauge
        # HELP buck2_cache_join_runs_selected Window join runs selected by cache lane.
        # TYPE buck2_cache_join_runs_selected gauge
        # HELP buck2_cache_join_artifacts_selected Window join artifacts selected by cache lane.
        # TYPE buck2_cache_join_artifacts_selected gauge
        "
      `)
  })
  it('selects the previous complete UTC day at and between midnight boundaries', () => {
    expect(previousUtcDay(Date.parse('2026-10-22T00:00:00Z'))).toEqual({
      since: Date.parse('2026-10-21T00:00:00Z'),
      until: Date.parse('2026-10-22T00:00:00Z'),
    })
    expect(previousUtcDay(Date.parse('2026-10-22T23:59:59.999Z'))).toEqual(
      previousUtcDay(Date.parse('2026-10-22T00:00:00Z')),
    )
    expect(previousUtcDay(0)).toEqual({ since: -86_400_000, until: 0 })
  })

  it('exports disjoint cold and changed cohorts and the remaining warm99 counts to OTLP', () => {
    const report = reportFor([
      observation(writerFixture(), 'main-writer'),
      observation(
        artifactFixture(false, [
          actionFixture(),
          actionFixture({ digest: 'feedbeef:12' }),
          actionFixture({ target: 'test//:cold' }),
          actionFixture({ target: 'test//:noncacheable', executionKind: 0 }),
          actionFixture({ category: 'pnpm_extract' }),
          actionFixture({
            target: 'test//:failed-upload',
            executionKind: 1,
            cacheUploadResult: 9,
            uploadOutcome: 'failed',
          }),
        ]),
      ),
    ])
    const metrics = renderOtlp(report).resourceMetrics[0]?.scopeMetrics[0]?.metrics
    for (const [cohort, value] of [
      ['eligible', 1],
      ['cold', 2],
      ['changed', 1],
      ['noncacheable', 1],
      ['excluded', 1],
      ['upload_failure', 1],
    ] as const) {
      const metric = metrics?.find((metric) => metric.name === `buck2.cache.lane.${cohort}_actions`)
      expect(metric?.gauge.dataPoints).toContainEqual({
        attributes: [
          { key: 'repo', value: { stringValue: 'public/test' } },
          { key: 'lane', value: { stringValue: 'main-reader' } },
          { key: 'platform', value: { stringValue: 'linux' } },
        ],
        timeUnixNano: '1000000000000',
        asDouble: value,
      })
    }
  })

  it('renders canonical OTLP gauges with the window end as sample timestamp', () => {
    const report = reportFor([
      observation(writerFixture(), 'main-writer'),
      observation(artifactFixture()),
    ])
    const payload = renderOtlp(report)
    const resource = payload.resourceMetrics[0]
    expect(resource?.resource).toMatchInlineSnapshot(`
      {
        "attributes": [
          {
            "key": "service.name",
            "value": {
              "stringValue": "effect-utils-buck2",
            },
          },
          {
            "key": "service.namespace",
            "value": {
              "stringValue": "infra",
            },
          },
        ],
      }
    `)
    const metrics = resource?.scopeMetrics[0]?.metrics
    expect(metrics?.[0]?.name).toBe('buck2.cache.lane.eligible_actions')
    expect(metrics?.[0]?.gauge.dataPoints[0]).toMatchInlineSnapshot(`
      {
        "asDouble": 1,
        "attributes": [
          {
            "key": "repo",
            "value": {
              "stringValue": "public/test",
            },
          },
          {
            "key": "lane",
            "value": {
              "stringValue": "main-reader",
            },
          },
          {
            "key": "platform",
            "value": {
              "stringValue": "linux",
            },
          },
        ],
        "timeUnixNano": "1000000000000",
      }
    `)
    expect(
      metrics?.find((metric) => metric.name === 'buck2.cache.join.runs')?.gauge.dataPoints[0],
    ).toEqual({
      attributes: [{ key: 'repo', value: { stringValue: 'public/test' } }],
      timeUnixNano: '1000000000000',
      asDouble: 5,
    })
  })

  it('retains sampling independently of joined artifacts and evidence gaps', () => {
    const input = {
      repo: 'public/test',
      observations: [observation(writerFixture(), 'main-writer'), observation(artifactFixture())],
      runs: 5,
      artifacts: 7,
      windowEndTimestampSeconds: 1000,
      evidenceGaps: [{ lane: 'pr' as const, count: 2 }],
      unlabelledEvidenceGaps: 3,
    }
    const samples: JoinSample[] = [
      { lane: 'main-reader', seen: 100, selected: 25, artifacts: 40 },
      { lane: 'pr', seen: 70, selected: 25, artifacts: 30 },
      { lane: 'main-writer', seen: 45, selected: 45, artifacts: 50 },
      { lane: 'merge_group', seen: 0, selected: 0, artifacts: 0 },
    ]
    const unsampled = aggregate(input)
    expect(unsampled.sampling).toEqual([])
    expect(aggregate({ ...input, samples })).toEqual({ ...unsampled, sampling: samples })
    expect(unsampled.join_artifacts).toBe(7)
    expect(unsampled.join_runs).toBe(5)
    expect(unsampled.evidence_gaps).toBe(5)
  })

  it('renders sampling as lane-only window gauges in Prometheus and OTLP', () => {
    const samples: JoinSample[] = [
      { lane: 'main-reader', seen: 100, selected: 25, artifacts: 40 },
      { lane: 'pr', seen: 70, selected: 25, artifacts: 30 },
      { lane: 'main-writer', seen: 45, selected: 45, artifacts: 50 },
      { lane: 'merge_group', seen: 0, selected: 0, artifacts: 0 },
    ]
    const report = aggregate({
      repo: 'public/test',
      observations: [],
      runs: 0,
      windowEndTimestampSeconds: 1000,
      samples,
    })
    const prometheus = renderPrometheus(report)
    const metrics = renderOtlp(report).resourceMetrics[0]?.scopeMetrics[0]?.metrics
    for (const [name, key] of [
      ['runs_seen', 'seen'],
      ['runs_selected', 'selected'],
      ['artifacts_selected', 'artifacts'],
    ] as const) {
      const prometheusName = `buck2_cache_join_${name}`
      expect(prometheus).toContain(`# TYPE ${prometheusName} gauge\n`)
      expect(
        prometheus.split('\n').filter((line) => line.startsWith(`${prometheusName}{`)),
      ).toEqual(
        samples.map(
          (sample) =>
            `${prometheusName}{repo="public/test",lane="${sample.lane}"} ${sample[key]} 1000000`,
        ),
      )
      expect(metrics?.find((metric) => metric.name === `buck2.cache.join.${name}`)).toEqual({
        name: `buck2.cache.join.${name}`,
        description: `Window join ${name.replaceAll('_', ' ')} by cache lane.`,
        unit: '1',
        gauge: {
          dataPoints: samples.map((sample) => ({
            attributes: [
              { key: 'repo', value: { stringValue: 'public/test' } },
              { key: 'lane', value: { stringValue: sample.lane } },
            ],
            timeUnixNano: '1000000000000',
            asDouble: sample[key],
          })),
        },
      })
    }
  })
})
