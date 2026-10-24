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
        { runId: 1, job: 'quality' },
        { runId: 2, job: 'reader' },
        { runId: 3, job: 'reader' },
      ],
      sources: [
        {
          id: 101,
          runId: 1,
          lane: 'main-writer',
          job: 'quality',
          trustedWriter: true,
          startedAt: 1000,
          finishedAt: 1100,
        },
        {
          id: 102,
          runId: 2,
          lane: 'main-reader',
          job: 'reader',
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
          lane: 'main-reader',
          job: 'reader',
          trustedWriter: false,
          startedAt: 3000,
          finishedAt: 3100,
        },
      ],
      expectedJobs: [{ runId: 3, job: 'reader' }],
    })
    expect(planned.manifest.observations[0]!.readers).toEqual([])
    expect(planned.manifest.observations[1]!.readers).toHaveLength(1)
    expect(planned.evidenceGaps).toContain('expected-reader-observation-unavailable')
  })
  it('keeps missing expected writer uploads explicit', () => {
    const planned = planProofHistory({
      runs: [run(1, 'push', 'ci.yml'), run(2), run(3)],
      sources: [],
      expectedJobs: [{ runId: 1, job: 'quality' }],
    })
    expect(planned.manifest.observations[0]!.writers[0]!.actions).toBe('missing/writer-1-0.gz')
    expect(planned.evidenceGaps).toContain('expected-writer-job-evidence-unavailable')
  })
  it('does not use read-only merge jobs or future writers as trusted prior uploads', () => {
    const planned = planProofHistory({
      expectedLanes: ['main-reader'],
      runs: [run(1, 'merge_group', 'ci.yml'), run(2), run(3)],
      expectedJobs: [
        { runId: 1, job: 'store-gc' },
        { runId: 2, job: 'reader' },
        { runId: 3, job: 'reader' },
        { runId: 1, job: 'quality' },
      ],
      sources: [
        {
          id: 101,
          runId: 1,
          lane: 'merge_group',
          job: 'store-gc',
          trustedWriter: false,
          startedAt: 1000,
          finishedAt: 1100,
        },
        {
          id: 102,
          runId: 2,
          lane: 'main-reader',
          job: 'reader',
          trustedWriter: false,
          startedAt: 2000,
          finishedAt: 2100,
        },
        {
          id: 103,
          runId: 3,
          lane: 'main-reader',
          job: 'reader',
          trustedWriter: false,
          startedAt: 3000,
          finishedAt: 3100,
        },
        {
          id: 104,
          runId: 1,
          lane: 'merge_group',
          job: 'quality',
          trustedWriter: true,
          startedAt: 4000,
          finishedAt: 4100,
        },
      ],
    })
    expect(planned.manifest.observations.map((observation) => observation.writers)).toEqual([
      [],
      [],
    ])
    expect(planned.evidenceGaps).toEqual([])
  })
})
