import { describe, expect, it } from 'bun:test'

import type { EvidenceRun } from './buck2-cache-join-discovery.ts'
import {
  planProofHistory,
  proofReaderLane,
  selectProofReaderRuns,
  selectProofRelevantRuns,
} from './buck2-cache-proof-history.ts'

const run = (id: number, event = 'push', workflow = 'ci.yml'): EvidenceRun => ({
  id,
  event,
  workflow,
  head_branch: 'main',
  created_at: new Date(id * 1000).toISOString(),
})
describe('authoritative proof history planning', () => {
  it('selects the final two real chronological runs independently per enabled reader lane', () => {
    expect(
      selectProofReaderRuns([run(1), run(2), run(3), run(4, 'pull_request')]).map(
        (item) => item.id,
      ),
    ).toEqual([3, 2, 4])
  })
  it('uses actual CI reader lanes instead of q33 approximate run labels or Storybook runs', () => {
    expect(proofReaderLane(run(1))).toBe('main-reader')
    expect(proofReaderLane(run(2, 'schedule', 'storybook-plays.yml'))).toBeUndefined()
    expect(
      selectProofRelevantRuns(Array.from({ length: 100 }, (_, index) => run(index + 1)))
        .map((item) => item.id)
        .toSorted((left, right) => left - right),
    ).toEqual([97, 98, 99, 100])
  })
  it('retains missing expected jobs as unresolved references instead of dropping denominators', () => {
    const planned = planProofHistory({
      runs: [run(1, 'push', 'ci.yml'), run(2), run(3)],
      expectedJobs: [
        { runId: 1, job: 'quality', cell: 'singleton', runAttempt: 1 },
        { runId: 2, job: 'reader', cell: 'singleton', runAttempt: 1 },
        { runId: 3, job: 'reader', cell: 'singleton', runAttempt: 1 },
      ],
      sources: [
        {
          id: 101,
          runId: 1,
          runAttempt: 1,
          lane: 'main-writer',
          job: 'quality',
          cell: 'singleton',
          trustedWriter: true,
          startedAt: 1000,
          finishedAt: 1100,
        },
        {
          id: 102,
          runId: 2,
          runAttempt: 1,
          lane: 'main-reader',
          job: 'reader',
          cell: 'singleton',
          trustedWriter: false,
          startedAt: 2000,
          finishedAt: 2100,
        },
      ],
    })
    expect(planned.manifest.enabledLanes).toEqual(['main-reader', 'merge_group', 'pr'])
    expect(planned.evidenceGaps).toContain('expected-reader-observation-unavailable')
    expect(planned.manifest.observations[0]!.readers[0]!.actions).toBe(
      'sources/102/buck2-cache-actions.jsonl.gz',
    )
    expect(planned.manifest.observations[1]!.readers[0]!.actions).toBe('missing/3-0.gz')
    expect(planned.evidenceGaps).toContain('expected-reader-job-evidence-unavailable')
    expect(planned.manifest.observations[1]!.writers[0]!.actions).toBe(
      'sources/101/buck2-cache-actions.jsonl.gz',
    )
  })
  it('does not replay a single discovered run to manufacture two observations', () => {
    const planned = planProofHistory({
      runs: [run(3)],
      sources: [
        {
          id: 103,
          runId: 3,
          runAttempt: 1,
          lane: 'main-reader',
          job: 'reader',
          cell: 'singleton',
          trustedWriter: false,
          startedAt: 3000,
          finishedAt: 3100,
        },
      ],
      expectedJobs: [{ runId: 3, job: 'reader', cell: 'singleton', runAttempt: 1 }],
    })
    expect(planned.manifest.observations[0]!.readers).toEqual([])
    expect(planned.manifest.observations[1]!.readers).toHaveLength(1)
    expect(planned.evidenceGaps).toContain('expected-reader-observation-unavailable')
  })
  it('keeps missing expected writer uploads explicit', () => {
    const planned = planProofHistory({
      runs: [run(1, 'push', 'ci.yml'), run(2), run(3)],
      sources: [],
      expectedJobs: [{ runId: 1, job: 'quality', cell: 'singleton', runAttempt: 1 }],
    })
    expect(planned.manifest.observations[0]!.writers[0]!.actions).toBe('missing/writer-1-0.gz')
    expect(planned.evidenceGaps).toContain('expected-writer-job-evidence-unavailable')
  })
  it('retains trusted writers regardless of job completion; per-action timestamps decide eligibility', () => {
    const planned = planProofHistory({
      expectedLanes: ['main-reader'],
      runs: [run(1), run(2), run(3)],
      expectedJobs: [
        { runId: 1, job: 'store-gc', cell: 'singleton', runAttempt: 1 },
        { runId: 2, job: 'reader', cell: 'singleton', runAttempt: 1 },
        { runId: 3, job: 'reader', cell: 'singleton', runAttempt: 1 },
        { runId: 1, job: 'quality', cell: 'singleton', runAttempt: 1 },
      ],
      sources: [
        {
          id: 101,
          runId: 1,
          runAttempt: 1,
          lane: 'merge_group',
          job: 'store-gc',
          cell: 'singleton',
          trustedWriter: false,
          startedAt: 1000,
          finishedAt: 1100,
        },
        {
          id: 102,
          runId: 2,
          runAttempt: 1,
          lane: 'main-reader',
          job: 'reader',
          cell: 'singleton',
          trustedWriter: false,
          startedAt: 2000,
          finishedAt: 2100,
        },
        {
          id: 103,
          runId: 3,
          runAttempt: 1,
          lane: 'main-reader',
          job: 'reader',
          cell: 'singleton',
          trustedWriter: false,
          startedAt: 3000,
          finishedAt: 3100,
        },
        {
          id: 104,
          runId: 1,
          runAttempt: 1,
          lane: 'main-writer',
          job: 'quality',
          cell: 'singleton',
          trustedWriter: true,
          startedAt: 1500,
          finishedAt: 4100,
        },
      ],
    })
    expect(planned.manifest.observations.map((observation) => observation.writers)).toEqual([
      [
        {
          lane: 'main-writer',
          summary: 'sources/104/buck2-cache-evidence.json',
          actions: 'sources/104/buck2-cache-actions.jsonl.gz',
        },
      ],
      [
        {
          lane: 'main-writer',
          summary: 'sources/104/buck2-cache-evidence.json',
          actions: 'sources/104/buck2-cache-actions.jsonl.gz',
        },
      ],
    ])
    expect(planned.evidenceGaps).toEqual([])
  })
  it('does not require a future writer to complete an earlier reader observation', () => {
    const jobs = [1, 2, 3].map((runId) => ({
      runId,
      job: runId === 3 ? 'quality' : 'reader',
      cell: 'singleton',
      runAttempt: 1,
    }))
    const planned = planProofHistory({
      runs: [run(1, 'pull_request'), run(2, 'pull_request'), run(3)],
      expectedLanes: ['pr'],
      expectedJobs: jobs,
      sources: jobs.map((job, index) =>
        Object.assign({}, job, {
          id: 100 + index,
          lane: job.runId === 3 ? ('main-writer' as const) : ('pr' as const),
          trustedWriter: job.runId === 3,
          startedAt: job.runId * 1000,
          finishedAt: null,
        }),
      ),
    })
    expect(planned.evidenceGaps).toEqual([])
    expect(planned.manifest.observations.map((observation) => observation.writers)).toEqual([
      [],
      [],
    ])
  })
  it('preserves non-rerun successes and mixed-attempt matrix multiplicity', () => {
    const expectedJobs = [
      { runId: 1, job: 'quality', cell: 'cell-0', runAttempt: 1 },
      { runId: 1, job: 'quality', cell: 'cell-1', runAttempt: 2 },
      { runId: 2, job: 'reader', cell: 'singleton', runAttempt: 1 },
      { runId: 2, job: 'matrix', cell: 'cell-0', runAttempt: 1 },
      { runId: 2, job: 'matrix', cell: 'cell-1', runAttempt: 2 },
      { runId: 2, job: 'matrix', cell: 'cell-2', runAttempt: 2 },
      { runId: 3, job: 'reader', cell: 'singleton', runAttempt: 1 },
    ]
    const sources = expectedJobs.map((job, index) => ({
      ...job,
      id: 100 + index,
      lane: job.runId === 1 ? ('main-writer' as const) : ('main-reader' as const),
      trustedWriter: job.runId === 1,
      startedAt: job.runId * 1000,
      finishedAt: job.runId * 1000 + 100,
    }))
    const planned = planProofHistory({
      expectedLanes: ['main-reader'],
      runs: [run(1), run(2), run(3)],
      expectedJobs,
      sources,
    })
    expect(planned.evidenceGaps).toEqual([])
    expect(planned.manifest.observations[0]!.readers.map((source) => source.actions)).toEqual(
      sources.slice(2, 6).map((source) => `sources/${source.id}/buck2-cache-actions.jsonl.gz`),
    )
    expect(planned.manifest.observations.map((observation) => observation.writers.length)).toEqual([
      2, 2,
    ])

    // An extra old-attempt upload cannot replace a missing latest matrix instance.
    const missingMatrix = planProofHistory({
      expectedLanes: ['main-reader'],
      runs: [run(1), run(2), run(3)],
      expectedJobs,
      sources: [...sources.filter((source) => source.id !== 105), { ...sources[3]!, id: 200 }],
    })
    expect(missingMatrix.evidenceGaps).toContain('expected-reader-job-evidence-unavailable')
    expect(missingMatrix.manifest.observations[0]!.readers.at(-1)!.actions).toBe('missing/2-3.gz')

    // A stale writer with the wrong attempt must not mask its missing rerun evidence.
    const missingWriter = planProofHistory({
      expectedLanes: ['main-reader'],
      runs: [run(1), run(2), run(3)],
      expectedJobs,
      sources: [...sources.filter((source) => source.id !== 101), { ...sources[0]!, id: 201 }],
    })
    expect(missingWriter.evidenceGaps).toContain('expected-writer-job-evidence-unavailable')
    expect(missingWriter.manifest.observations[0]!.writers.at(-1)!.actions).toBe(
      'missing/writer-1-1.gz',
    )
  })
  it('never substitutes a stale sibling cell for missing reader or writer evidence', () => {
    for (const writer of [false, true]) {
      const runId = writer === true ? 1 : 2
      const job = writer === true ? 'quality' : 'matrix'
      const expectedJobs = [
        { runId, job, cell: 'cell-0', runAttempt: 1 },
        { runId, job, cell: 'cell-1', runAttempt: 2 },
      ]
      const sources = expectedJobs.map((expected, index) => ({
        ...expected,
        id: 100 + index,
        lane: writer === true ? ('main-writer' as const) : ('main-reader' as const),
        trustedWriter: writer,
        startedAt: runId * 1000,
        finishedAt: runId * 1000 + 100,
      }))
      const staleSibling = { ...sources[1]!, id: 200, runAttempt: 1 }
      const plan = (includeFirstCell: boolean) =>
        planProofHistory({
          expectedLanes: ['main-reader'],
          runs: [run(1), run(2), run(3)],
          expectedJobs,
          sources: [...(includeFirstCell === true ? [sources[0]!] : []), staleSibling, sources[1]!],
        })

      // A@1 missing, B@1 stale, B@2 current: B@1 cannot fill A@1.
      const missing = plan(false)
      const missingRefs =
        writer === true
          ? missing.manifest.observations[0]!.writers
          : missing.manifest.observations[0]!.readers
      expect(missingRefs.map((ref) => ref.actions)).toEqual([
        'sources/101/buck2-cache-actions.jsonl.gz',
        writer === true ? 'missing/writer-1-0.gz' : 'missing/2-0.gz',
      ])
      expect(missing.evidenceGaps).toContain(
        writer === true
          ? 'expected-writer-job-evidence-unavailable'
          : 'expected-reader-job-evidence-unavailable',
      )

      // Even when A@1 exists, B@1 is not a discovered latest cell.
      const present = plan(true)
      const presentRefs =
        writer === true
          ? present.manifest.observations[0]!.writers
          : present.manifest.observations[0]!.readers
      expect(presentRefs.map((ref) => ref.actions)).toEqual([
        'sources/100/buck2-cache-actions.jsonl.gz',
        'sources/101/buck2-cache-actions.jsonl.gz',
      ])
      expect(present.evidenceGaps).not.toContain(
        writer === true
          ? 'expected-writer-job-evidence-unavailable'
          : 'expected-reader-job-evidence-unavailable',
      )
    }
  })
})
