import { describe, expect, it } from 'bun:test'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import {
  actionFixture,
  artifactFixture,
  loadedFixture,
  manifestFixture,
} from './buck2-cache-warm99.fixtures.ts'
import { decodeManifest, evaluateWarm99 } from './buck2-cache-warm99.ts'

const rawArtifact = (artifact = artifactFixture()): string =>
  `${[artifact.header, ...artifact.actions].map((item) => JSON.stringify(item)).join('\n')}\n`
describe('strict action boundary', () => {
  it('preserves unsupported raw enums only in explicitly incomplete artifacts', () => {
    const artifact = artifactFixture(false, [
      actionFixture({ executionKind: 99, cacheUploadResult: 99 }),
    ])
    artifact.header.complete = false
    artifact.header.evidenceGaps = ['unsupported-native-enum']
    const decoded = decodeActionArtifact(rawArtifact(artifact))
    expect(decoded.actions[0]?.executionKind).toBe(99)
    expect(decoded.actions[0]?.cacheUploadResult).toBe(99)
    expect(decoded.header.complete).toBe(false)
  })
  it('retains null identities and legitimate noncommand digest omissions', () => {
    const artifact = artifactFixture(false, [actionFixture({ commandAction: false, digest: null })])
    expect(decodeActionArtifact(rawArtifact(artifact)).actions[0]?.digest).toBeNull()
  })
  it('rejects unsupported schemas/enums, missing fields and truncated rows', () => {
    const raw = rawArtifact()
    for (const bad of [
      raw.replace('"schemaVersion":1', '"schemaVersion":2'),
      raw.replace('"executionKind":3', '"executionKind":99'),
      raw.replace('"cacheUploadResult":0', '"cacheUploadResult":17'),
      raw.replace('"configuration":"linux#1",', ''),
      raw.slice(0, -1),
      raw.replace('"lane":"main-reader"', '"lane":"unknown"'),
    ]) {
      expect(() => decodeActionArtifact(bad)).toThrow()
    }
  })
  it('retains explicit incomplete count mismatches but rejects purported complete ones', () => {
    const artifact = artifactFixture()
    artifact.header.actionCount++
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.complete = false
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(false)
  })
  it('rejects complete invocations outside the job window while accepting equality', () => {
    const artifact = artifactFixture()
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(true)
    artifact.header.metadata.startedAt = 201
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.metadata.startedAt = 200
    artifact.header.metadata.finishedAt = 299
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.complete = false
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(false)
  })
})
describe('warm99 identity acceptance', () => {
  it('invalidates observations whose native invocations fall outside the job window', () => {
    for (const bound of ['start', 'finish'] as const) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const reader = item.readers[0]
        if (reader === undefined) throw new Error('fixture')
        if (bound === 'start') reader.header.metadata.startedAt = 201
        else reader.header.metadata.finishedAt = 299
      }
      const report = evaluateWarm99(manifest, loaded)
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.observations[0]?.complete).toBe(false)
      expect(report.lanes[0]?.observations[0]?.evidenceGap).toBeGreaterThan(0)
    }
  })
  it('requires two observations for every lane and keeps Nix separate', () => {
    const manifest = manifestFixture(['main-reader', 'merge_group', 'pr'])
    const report = evaluateWarm99(manifest, loadedFixture(manifest))
    expect(report.accepted).toBe(true)
    expect(report.lanes.map((lane) => lane.consecutive)).toEqual([2, 2, 2])
    expect(report.lanes[0]?.observations[0]?.nixSubstitution.substituted).toBe(5)
    const single = manifestFixture(['main-reader'], 1)
    expect(evaluateWarm99(single, loadedFixture(single)).accepted).toBe(false)
  })
  it('strictly orders upload before reader (equality is cold) and matches configuration', () => {
    for (const mode of ['equal', 'later', 'configuration']) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        const action = writer?.actions[0]
        if (action === undefined) throw new Error('fixture')
        if (mode === 'configuration') action.configuration = 'linux#other'
        else action.uploadCompletedAt = mode === 'equal' ? 200 : 201
      }
      const report = evaluateWarm99(manifest, loaded)
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.observations[0]?.eligible).toBe(0)
      expect(report.lanes[0]?.observations[0]?.cold).toBe(1)
    }
  })
  it('deduplicates identities and requires all reader occurrences remote including kind7', () => {
    for (const kind of [3, 1, 7]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded)
        item.readers = [
          artifactFixture(false, [actionFixture(), actionFixture({ executionKind: kind })]),
        ]
      const report = evaluateWarm99(manifest, loaded)
      expect(report.lanes[0]?.observations[0]?.eligible).toBe(1)
      expect(report.lanes[0]?.observations[0]?.remoteHits).toBe(kind === 3 ? 1 : 0)
      expect(report.accepted).toBe(kind === 3)
    }
  })
  it('raw remote hit wins over uploaded compact outcome', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded)
      item.readers = [
        artifactFixture(false, [
          actionFixture({
            outcome: 'uploaded',
            cacheUploadResult: 1,
            uploadOutcome: 'uploaded',
            uploadCompletedAt: 210,
          }),
        ]),
      ]
    expect(evaluateWarm99(manifest, loaded).accepted).toBe(true)
  })
  it('aggregates eligible readers only and reports earlier cold occurrence separately', () => {
    for (const start of [50, 200]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        item.observation.readers.push({
          lane: 'main-reader',
          summary: 'second.json',
          actions: 'second.gz',
        })
        const early = artifactFixture(false, [actionFixture({ executionKind: 1 })])
        early.header.metadata.startedAt = Math.min(start, 200)
        for (const invocation of early.header.invocations) invocation.startedAt = start
        item.readers = [early, artifactFixture()]
      }
      const report = evaluateWarm99(manifest, loaded)
      expect(report.lanes[0]?.observations[0]).toMatchObject({
        eligible: 1,
        remoteHits: start === 50 ? 1 : 0,
        cold: start === 50 ? 1 : 0,
      })
      expect(report.accepted).toBe(start === 50)
    }
  })
  it('excludes later nonfresh invocations without invalidating the fresh first invocation', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const reader = artifactFixture(false, [
        actionFixture(),
        actionFixture({ buildId: 'later', executionKind: 7 }),
      ])
      const first = reader.header.invocations[0]
      if (first === undefined) throw new Error('fixture')
      first.actionCount = 1
      for (const action of reader.actions)
        if (action.buildId === 'later') action.buildId = `${first.buildId}-later`
      reader.header.invocations.push({
        buildId: `${first.buildId}-later`,
        context: 'test',
        startedAt: 250,
        completedAt: 300,
        freshRoot: false,
        actionCount: 1,
        complete: true,
      })
      item.readers = [reader]
    }
    const report = evaluateWarm99(manifest, loaded)
    expect(report.accepted).toBe(true)
    expect(report.lanes[0]?.observations[0]).toMatchObject({
      eligible: 1,
      remoteHits: 1,
      excluded: 1,
    })
  })
  it('missing digest, metadata, nonfresh invocation, and missing reader invalidate', () => {
    for (const mode of ['digest', 'metadata', 'fresh', 'missing', 'invocation']) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const artifact = item.readers[0]
        if (artifact === undefined) throw new Error('fixture')
        if (mode === 'digest') artifact.actions = [actionFixture({ digest: null })]
        if (mode === 'metadata') artifact.header.metadata.runId = null
        if (mode === 'fresh') for (const inv of artifact.header.invocations) inv.freshRoot = false
        if (mode === 'invocation')
          for (const inv of artifact.header.invocations) inv.complete = false
        if (mode === 'missing') item.readers = [undefined]
      }
      expect(evaluateWarm99(manifest, loaded).accepted).toBe(false)
    }
  })
  it('gap breaks streak and zero eligible never passes', () => {
    const manifest = manifestFixture(['main-reader'], 4)
    const loaded = loadedFixture(manifest)
    const gap = loaded[2]
    if (gap === undefined) throw new Error('fixture')
    gap.writers = [undefined]
    expect(evaluateWarm99(manifest, loaded).lanes[0]?.consecutive).toBe(1)
    for (const item of loaded) item.readers = [artifactFixture(false, [])]
    expect(evaluateWarm99(manifest, loaded).accepted).toBe(false)
  })
  it('reports cold, changed, exclusions, noncacheable and upload failures separately', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      item.readers = [
        artifactFixture(false, [
          actionFixture(),
          actionFixture({ digest: 'changed:1' }),
          actionFixture({ target: '//:cold' }),
          actionFixture({ commandAction: false, digest: null }),
          actionFixture({ target: '//:noncacheable', executionKind: 0 }),
        ]),
      ]
      const writer = item.writers[0]
      if (writer === undefined) throw new Error('fixture')
      writer.actions.push(actionFixture({ uploadOutcome: 'failed', cacheUploadResult: 9 }))
    }
    const result = evaluateWarm99(manifest, loaded).lanes[0]?.observations[0]
    expect(result).toMatchObject({
      eligible: 1,
      changed: 1,
      cold: 1,
      excluded: 0,
      noncacheable: 2,
      uploadFailure: 1,
    })
  })
  it('99/100 meets threshold, 98/100 fails', () => {
    for (const hits of [99, 98]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        if (writer === undefined) throw new Error('fixture')
        const invocation = writer.header.invocations[0]
        if (invocation === undefined) throw new Error('fixture')
        writer.actions = Array.from({ length: 100 }, (_, i) =>
          actionFixture({
            buildId: invocation.buildId,
            digest: `${i.toString(16)}:1`,
            executionKind: 1,
            uploadOutcome: 'uploaded',
            cacheUploadResult: 1,
            startedAt: 10,
            completedAt: 100,
            endTime: 100,
            uploadCompletedAt: 100,
          }),
        )
        writer.header.actionCount = 100
        writer.header.rows = 100
        invocation.actionCount = 100
        item.readers = [
          artifactFixture(
            false,
            Array.from({ length: 100 }, (_, i) =>
              actionFixture({ digest: `${i.toString(16)}:1`, executionKind: i < hits ? 3 : 1 }),
            ),
          ),
        ]
      }
      expect(evaluateWarm99(manifest, loaded).accepted).toBe(hits === 99)
    }
  })
  it('rejects equal/decreasing sequences, duplicate IDs and unknown lanes', () => {
    for (const mode of ['equal', 'decrease', 'id', 'lane']) {
      const manifest = manifestFixture()
      const second = manifest.observations[1]
      if (second === undefined) throw new Error('fixture')
      if (mode === 'equal') second.sequence = 0
      if (mode === 'decrease') second.sequence = -1
      if (mode === 'id') second.id = 'observation-0'
      const value: unknown = mode === 'lane' ? { ...manifest, enabledLanes: ['unknown'] } : manifest
      expect(() => decodeManifest(value)).toThrow()
    }
  })
})

describe('evidence trust boundaries', () => {
  it('rejects unsafe identities and metadata, wrong mapping and inconsistent timestamps/counters', () => {
    const artifact = artifactFixture()
    const raw = rawArtifact(artifact)
    const variants = [
      raw.replace('"target":"test//:test"', '"target":"/home/private/file"'),
      raw.replace('"configuration":"linux#1"', '"configuration":"/home/private/config"'),
      raw.replace('"digest":"abcd:12"', '"digest":"not-a-digest"'),
      raw.replace('"repo":"public/test"', '"repo":"/home/private/repo"'),
      raw.replace('"headSha":"' + 'a'.repeat(40) + '"', '"headSha":"secret"'),
      raw.replace('"runId":"1"', '"runId":"secret"'),
      raw.replace('"cacheOutcome":"remote-hit"', '"cacheOutcome":"local"'),
      raw.replace('"endTime":210', '"endTime":211'),
      raw.replace('"missingIdentityCount":0', '"missingIdentityCount":1'),
      raw.replace('"missingTimestampCount":0', '"missingTimestampCount":1'),
      raw.replace('"startedAt":200,"completedAt":300', '"startedAt":205,"completedAt":300'),
    ]
    for (const variant of variants) expect(() => decodeActionArtifact(variant)).toThrow()
  })
  it('rejects fabricated upload completion bounds', () => {
    const artifact = artifactFixture(true, [
      actionFixture({ cacheUploadResult: 1, uploadOutcome: 'uploaded', uploadCompletedAt: 209 }),
    ])
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
  })
  it('cannot replay one native reader invocation into two passing observations', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    const first = loaded[0]
    const second = loaded[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    second.readers = first.readers
    const report = evaluateWarm99(manifest, loaded)
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[1]?.evidenceGap).toBe(1)
  })
  it('never establishes eligibility from another repository', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const writer = item.writers[0]
      if (writer === undefined) throw new Error('fixture')
      writer.header.metadata.repo = 'unrelated/repo'
    }
    const report = evaluateWarm99(manifest, loaded)
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[0]?.evidenceGap).toBeGreaterThan(0)
  })
})

describe('known failure reporting', () => {
  it('retains writer and reader upload failures even when evidence is incomplete', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const failure = actionFixture({ cacheUploadResult: 9, uploadOutcome: 'failed' })
      const writer = artifactFixture(true, [failure])
      const reader = artifactFixture(false, [failure])
      writer.header.complete = false
      reader.header.complete = false
      item.writers = [writer]
      item.readers = [reader]
    }
    const report = evaluateWarm99(manifest, loaded)
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[0]).toMatchObject({
      uploadFailure: 2,
      evidenceGap: 2,
      eligible: 0,
    })
  })
})

describe('cache lane posture', () => {
  it('accepts writer-posture main and queue jobs as observed readers', () => {
    const manifest = manifestFixture(['main-writer', 'merge_group'])
    const loaded = loadedFixture(manifest)
    for (const item of loaded)
      for (const artifact of item.readers) {
        if (artifact === undefined) throw new Error('fixture')
        artifact.header.metadata.posture = 'writer'
      }
    const report = evaluateWarm99(manifest, loaded)
    expect(report.accepted).toBe(true)
    expect(report.lanes.map((lane) => lane.consecutive)).toEqual([2, 2])
  })
  it('accepts queue writer sources but rejects PR writer posture or read-only writer sources', () => {
    for (const mode of ['queue', 'pr-reader', 'pr-writer', 'readonly-source']) {
      const manifest = manifestFixture(['pr'])
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        const reader = item.readers[0]
        const ref = item.observation.writers[0]
        if (writer === undefined || reader === undefined || ref === undefined)
          throw new Error('fixture')
        if (mode === 'queue') {
          ref.lane = 'merge_group'
          writer.header.metadata.lane = 'merge_group'
        }
        if (mode === 'pr-reader') reader.header.metadata.posture = 'writer'
        if (mode === 'pr-writer') {
          ref.lane = 'pr'
          writer.header.metadata.lane = 'pr'
        }
        if (mode === 'readonly-source') {
          ref.lane = 'main-reader'
          writer.header.metadata.lane = 'main-reader'
          writer.header.metadata.posture = 'read-only'
        }
      }
      expect(evaluateWarm99(manifest, loaded).accepted).toBe(mode === 'queue')
    }
  })
})
