import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import {
  actionExclusionReason,
  countActionExclusions,
  actionsArtifactName,
  cacheOutcomeMapping,
  outcomeFor,
  type ActionArtifact,
  type ActionRecord,
  type CacheLane,
} from './buck2-action-evidence.ts'
import type { LoadedObservation, WarmManifest } from './buck2-cache-warm99.ts'

export const actionFixture = (overrides: Partial<ActionRecord> = {}): ActionRecord => ({
  type: 'action',
  buildId: 'build',
  context: 'test',
  category: 'compile',
  exclusionReason: actionExclusionReason(overrides.category ?? 'compile'),
  target: 'test//:test',
  configuration: 'linux#1',
  digest: 'abcd:12',
  executionKind: 3,
  cacheUploadResult: 0,
  outcome: outcomeFor({
    executionKind: overrides.executionKind ?? 3,
    uploadResult: overrides.cacheUploadResult ?? 0,
  }),
  cacheOutcome: outcomeFor({
    executionKind: overrides.executionKind ?? 3,
    uploadResult: overrides.cacheUploadResult ?? 0,
  }),
  uploadOutcome: 'not-uploaded',
  startedAt: 200,
  completedAt: 210,
  endTime: 210,
  uploadCompletedAt: null,
  commandAction: true,
  ...overrides,
})
let fixtureId = 0
export const artifactFixture = (writer = false, input = [actionFixture()]): ActionArtifact => {
  const buildId = `build-${fixtureId++}`
  const actions = input.map((action) => ({
    ...action,
    buildId: action.buildId === 'build' ? buildId : action.buildId,
  }))
  return {
    header: {
      type: 'header',
      schemaVersion: 1,
      cacheOutcomeMapping,
      metadata: {
        repo: 'public/test',
        runId: '1',
        runAttempt: '1',
        job: 'test',
        lane: writer ? 'main-writer' : 'main-reader',
        headSha: 'a'.repeat(40),
        posture: writer ? 'writer' : 'read-only',
        startedAt: writer ? 10 : 200,
        finishedAt: 300,
      },
      status: 'collected',
      complete: true,
      actionCount: actions.length,
      excludedByDesign: countActionExclusions(actions),
      rows: actions.length,
      missingDigestCount: actions.filter((a) => a.digest === null).length,
      missingIdentityCount: 0,
      missingTimestampCount: 0,
      droppedActionCount: 0,
      evidenceGaps: [],
      invocations: [
        {
          buildId,
          context: 'test',
          startedAt: writer ? 10 : 200,
          completedAt: 300,
          freshRoot: true,
          actionCount: actions.length,
          excludedByDesign: countActionExclusions(actions),
          complete: true,
        },
      ],
    },
    actions,
  }
}
export const writerFixture = (): ActionArtifact =>
  artifactFixture(true, [
    actionFixture({
      executionKind: 1,
      cacheUploadResult: 1,
      uploadOutcome: 'uploaded',
      startedAt: 10,
      completedAt: 100,
      endTime: 100,
      uploadCompletedAt: 100,
    }),
  ])
export const manifestFixture = (lanes: CacheLane[] = ['main-reader'], count = 2): WarmManifest => ({
  schemaVersion: 1,
  enabledLanes: lanes,
  observations: Array.from({ length: count }, (_, index) => ({
    id: `observation-${index}`,
    sequence: index,
    writers: [
      { lane: 'main-writer', summary: `writer-${index}.json`, actions: `writer-${index}.gz` },
    ],
    readers: lanes.map((lane) => ({
      lane,
      summary: `${lane}-${index}.json`,
      actions: `${lane}-${index}.gz`,
    })),
    nixSubstitution: { substituted: 5, built: 1 },
  })),
})
export const loadedFixture = (manifest: WarmManifest): LoadedObservation[] =>
  manifest.observations.map((observation) => ({
    observation,
    writers: [writerFixture()],
    readers: observation.readers.map((ref) => {
      const artifact = artifactFixture()
      artifact.header.metadata.lane = ref.lane
      artifact.header.metadata.posture = ref.lane === 'main-writer' ? 'writer' : 'read-only'
      return artifact
    }),
  }))
export const encodedFixture = (artifact: ActionArtifact) => {
  const raw = `${[artifact.header, ...artifact.actions].map((item) => JSON.stringify(item)).join('\n')}\n`
  const compressed = gzipSync(raw)
  const counts: Record<string, number> = {
    'remote-hit': 0,
    local: 0,
    uploaded: 0,
    'local-cache': 0,
    'remote-execution': 0,
    'remote-dep-file-hit': 0,
    other: 0,
  }
  for (const action of artifact.actions) counts[action.outcome] = (counts[action.outcome] ?? 0) + 1
  return {
    raw,
    compressed,
    summary: {
      schemaVersion: 1,
      cacheOutcomeMapping,
      status: artifact.header.status,
      admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
      admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
      admissionInvocations: [],
      actionCount: artifact.actions.length,
      counts,
      excludedByDesign: artifact.header.excludedByDesign,
      invocations: artifact.header.invocations.map((invocation) => ({
        buildId: invocation.buildId,
        actionCount: invocation.actionCount,
        excludedByDesign: invocation.excludedByDesign,
      })),
      actionsArtifact: {
        name: actionsArtifactName,
        rows: artifact.header.rows,
        sha256: createHash('sha256').update(compressed).digest('hex'),
        bytes: compressed.length,
        uncompressedBytes: Buffer.byteLength(raw),
        complete: artifact.header.complete,
        droppedActionCount: 0,
      },
    },
  }
}
