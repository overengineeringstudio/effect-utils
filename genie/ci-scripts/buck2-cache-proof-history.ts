import { coreWriterJobIds } from '../ci-workflow/buck2-cache-proof-policy.ts'
import type { CacheLane } from './buck2-action-evidence.ts'
import type { EvidenceRun } from './buck2-cache-join-discovery.ts'
import type { ArtifactReference, WarmManifest } from './buck2-cache-warm99.ts'

export type HistorySource = {
  id: number
  runId: number
  runAttempt: number
  lane: CacheLane
  job: string
  cell: string
  trustedWriter: boolean
  startedAt: number | null
  latestStartedAt?: number | null
  finishedAt: number | null
}
/** `filter=latest` preserves each display-name cell's own attempt, not the run-wide maximum. */
export type ExpectedHistoryJob = { runId: number; job: string; cell: string; runAttempt: number }
const matchesExpectedHistoryJob = ({
  source,
  expected,
}: {
  source: ExpectedHistoryJob
  expected: ExpectedHistoryJob
}): boolean =>
  source.runId === expected.runId &&
  source.job === expected.job &&
  source.cell === expected.cell &&
  source.runAttempt === expected.runAttempt
/** Discovery's approximate q33 run classification is not a native job posture. */
export const proofReaderLane = (run: EvidenceRun): CacheLane | undefined => {
  if (run.workflow !== 'ci.yml') return undefined
  if (run.event === 'merge_group') return 'merge_group'
  if (run.event === 'pull_request' || run.event === 'pull_request_target') return 'pr'
  return run.head_branch === 'main' && run.event === 'push' ? 'main-reader' : undefined
}
export const selectProofReaderRuns = (runs: readonly EvidenceRun[]): EvidenceRun[] => {
  const lanes: CacheLane[] = ['main-reader', 'merge_group', 'pr']
  return lanes.flatMap((lane) =>
    runs
      .filter((run) => proofReaderLane(run) === lane)
      .toSorted(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
      )
      .slice(0, 2),
  )
}
/** Bound writer discovery to two preceding CI writer runs per real reader run, plus its own run. */
export const selectProofRelevantRuns = (runs: readonly EvidenceRun[]): EvidenceRun[] => {
  const readers = selectProofReaderRuns(runs)
  const result = new Map(readers.map((run) => [run.id, run]))
  for (const reader of readers) {
    const writers = runs
      .filter(
        (run) =>
          proofReaderLane(run) === 'main-reader' &&
          Date.parse(run.created_at) < Date.parse(reader.created_at),
      )
      .toSorted(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
      )
      .slice(0, 2)
    for (const writer of writers) result.set(writer.id, writer)
  }
  return [...result.values()]
}

/** Expectations come from GitHub run/job discovery and shared CI policy, never surviving artifacts alone. */
export const planProofHistory = ({
  runs,
  sources,
  expectedJobs,
  expectedLanes = ['main-reader', 'merge_group', 'pr'],
}: {
  runs: readonly EvidenceRun[]
  sources: readonly HistorySource[]
  expectedJobs: readonly ExpectedHistoryJob[]
  expectedLanes?: readonly CacheLane[]
}): { manifest: WarmManifest; evidenceGaps: string[] } => {
  const readers = selectProofReaderRuns(runs)
  const relevantRuns = selectProofRelevantRuns(runs)
  const enabledLanes = [...new Set(expectedLanes)]
  const evidenceGaps: string[] = []
  const expectedSources = sources.filter((source) =>
    expectedJobs.some((job) => matchesExpectedHistoryJob({ source, expected: job })),
  )
  const observations = [0, 1].map((index) => {
    const chosen = enabledLanes.flatMap((lane) => {
      const chronological = readers
        .filter((run) => proofReaderLane(run) === lane)
        .toSorted(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) || left.id - right.id,
        )
      const run = chronological[index - (2 - chronological.length)]
      if (run === undefined) {
        evidenceGaps.push('expected-reader-observation-unavailable')
        return []
      }
      return [run]
    })
    const readerSources = expectedSources
      .filter((source) =>
        chosen.some((run) => run.id === source.runId && source.lane === proofReaderLane(run)),
      )
      .toSorted((left, right) => left.id - right.id)
    const refs = readerSources.map(reference)
    for (const run of chosen) {
      const expected = expectedJobs.filter(
        (job) =>
          job.runId === run.id &&
          (proofReaderLane(run) !== 'main-reader' || coreWriterJobIds.has(job.job) !== true),
      )
      if (expected.length === 0) evidenceGaps.push('expected-reader-jobs-unavailable')
      for (const [position, job] of expected.entries()) {
        if (
          readerSources.filter((source) => matchesExpectedHistoryJob({ source, expected: job }))
            .length >
          expected
            .slice(0, position)
            .filter((item) => matchesExpectedHistoryJob({ source: item, expected: job })).length
        )
          continue
        evidenceGaps.push('expected-reader-job-evidence-unavailable')
        refs.push({
          lane: proofReaderLane(run)!,
          summary: `missing/${run.id}-${position}.json`,
          actions: `missing/${run.id}-${position}.gz`,
        })
      }
    }
    // A writer starting after every reader cannot establish earlier trusted presence.
    // Job completion is not a cutoff: individual observations can precede later readers.
    const latestReaderStart = Math.max(
      ...readerSources.map((source) => source.latestStartedAt ?? source.startedAt ?? -Infinity),
      ...chosen.map((run) => Date.parse(run.created_at)),
    )
    const writerSources = expectedSources
      .filter(
        (source) =>
          relevantRuns.some((run) => run.id === source.runId) &&
          source.trustedWriter === true &&
          source.lane === 'main-writer' &&
          readerSources.includes(source) !== true &&
          (source.startedAt === null || source.startedAt < latestReaderStart),
      )
      .toSorted((left, right) => left.id - right.id)
    const writers = writerSources.map(reference)
    for (const run of relevantRuns.filter(
      (item) =>
        Date.parse(item.created_at) < latestReaderStart && proofReaderLane(item) === 'main-reader',
    )) {
      const expected = expectedJobs.filter(
        (job) => job.runId === run.id && coreWriterJobIds.has(job.job) === true,
      )
      for (const [position, job] of expected.entries()) {
        const known = expectedSources.filter((source) =>
          matchesExpectedHistoryJob({ source, expected: job }),
        )
        if (
          known.length > 0 &&
          known.every(
            (source) =>
              source.trustedWriter !== true ||
              readerSources.includes(source) === true ||
              (source.startedAt !== null && source.startedAt >= latestReaderStart),
          ) === true
        )
          continue
        if (
          writerSources.filter((source) => matchesExpectedHistoryJob({ source, expected: job }))
            .length >
          expected
            .slice(0, position)
            .filter((item) => matchesExpectedHistoryJob({ source: item, expected: job })).length
        )
          continue
        evidenceGaps.push('expected-writer-job-evidence-unavailable')
        writers.push({
          lane: 'main-writer',
          summary: `missing/writer-${run.id}-${position}.json`,
          actions: `missing/writer-${run.id}-${position}.gz`,
        })
      }
    }
    return {
      id: `chronological-cohort-${index + 1}`,
      sequence: index + 1,
      readers: refs,
      writers,
      nixSubstitution: { substituted: 0, built: 0 },
    }
  })
  return {
    manifest: { schemaVersion: 1, enabledLanes, observations },
    evidenceGaps: [...new Set(evidenceGaps)],
  }
}

const reference = (source: HistorySource): ArtifactReference => ({
  lane: source.lane,
  summary: `sources/${source.id}/buck2-cache-evidence.json`,
  actions: `sources/${source.id}/buck2-cache-actions.jsonl.gz`,
})
