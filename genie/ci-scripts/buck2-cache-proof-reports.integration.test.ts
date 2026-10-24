import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ActionArtifact } from './buck2-action-evidence.ts'
import {
  proofManifestName,
  warm99ReportName,
  writeBuck2CacheProofReports,
} from './buck2-cache-proof-reports.ts'
import {
  actionFixture,
  artifactFixture,
  encodedFixture,
  loadedFixture,
  manifestFixture,
} from './buck2-cache-warm99.fixtures.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cache-proof-report-'))
  roots.push(root)
  return {
    root,
    summaryPath: join(root, 'buck2-cache-evidence.json'),
    actionsPath: join(root, 'buck2-cache-actions.jsonl.gz'),
  }
}
const put = async (summary: string, actions: string, artifact: ActionArtifact) => {
  const encoded = encodedFixture(artifact)
  await Bun.write(summary, JSON.stringify(encoded.summary))
  await Bun.write(actions, encoded.compressed)
}

describe('proof report publication', () => {
  it('keeps absent observations and writers as gaps and publishes checksummed real evidence', async () => {
    const options = await setup()
    await put(options.summaryPath, options.actionsPath, artifactFixture())
    await writeBuck2CacheProofReports(options)
    const warm = await Bun.file(join(options.root, warm99ReportName)).json()
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(warm.accepted).toBe(false)
    expect(warm.lanes.map((item: { lane: string }) => item.lane)).toEqual(['main-reader'])
    expect(warm.evidenceGaps).toContain('prior-writer-evidence-unavailable')
    expect(proof.expectedObservations.map((item: { id: string }) => item.id)).toEqual([
      'previous',
      'current',
    ])
    expect(proof.references[0].actions.actionCount).toBe(1)
    expect(proof.references[0].invocations[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.warm99.sha256).toBe(
      createHash('sha256')
        .update(
          await Bun.file(join(options.root, warm99ReportName))
            .arrayBuffer()
            .then((bytes) => new Uint8Array(bytes)),
        )
        .digest('hex'),
    )
    expect(JSON.stringify(proof)).not.toContain(options.root)
  })

  it('evaluates authoritative historical observations and binds actual earlier uploads', async () => {
    const options = await setup()
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      for (const [index, writer] of item.writers.entries())
        await put(
          join(options.root, item.observation.writers[index]!.summary),
          join(options.root, item.observation.writers[index]!.actions),
          writer!,
        )
      for (const [index, reader] of item.readers.entries())
        await put(
          join(options.root, item.observation.readers[index]!.summary),
          join(options.root, item.observation.readers[index]!.actions),
          reader!,
        )
    }
    await put(options.summaryPath, options.actionsPath, artifactFixture())
    const manifestPath = join(options.root, 'history.json')
    await Bun.write(manifestPath, JSON.stringify(manifest))
    await writeBuck2CacheProofReports({ ...options, manifestPath })
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(proof.accepted).toBe(true)
    expect(proof.references).toHaveLength(4)
    expect(
      proof.writerPriorUploadBindings[0].invocations[0].writers[0].successfulPriorUploadCount,
    ).toBe(1)
    expect(proof.historicalManifestSha256).toMatch(/^[a-f0-9]{64}$/)
    await Bun.write(join(options.root, manifest.observations[1]!.readers[0]!.actions), 'corrupt')
    await writeBuck2CacheProofReports({ ...options, manifestPath })
    expect((await Bun.file(join(options.root, warm99ReportName)).json()).accepted).toBe(false)
  })

  it('reports invalid current evidence without leaking paths or diagnostics', async () => {
    const options = await setup()
    await Bun.write(options.summaryPath, '{bad json with private data')
    await writeBuck2CacheProofReports(options)
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(proof.accepted).toBe(false)
    expect(proof.evidenceGaps).toContain('current-evidence-unavailable-or-invalid')
    expect(JSON.stringify(proof)).not.toContain('private data')
  })

  it('does not require native proof for disabled-by-design jobs', async () => {
    const options = await setup()
    const artifact = artifactFixture(false, [])
    artifact.header.metadata.posture = 'disabled-by-design'
    artifact.header.status = 'remote-cache-disabled-by-design'
    await put(options.summaryPath, options.actionsPath, artifact)
    await writeBuck2CacheProofReports(options)
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(proof.proofRequired).toBe(false)
    expect(proof.accepted).toBe(false)
    expect(proof.evidenceGaps).toEqual([])
  })

  it('retains shard checksum/counts and fails closed on incomplete index', async () => {
    const options = await setup()
    await put(options.summaryPath, options.actionsPath, artifactFixture())
    const shardIndexPath = `${options.summaryPath}.shard-index.json`
    await Bun.write(
      shardIndexPath,
      JSON.stringify({
        schemaVersion: 1,
        complete: false,
        evidenceGaps: ['missing'],
        expectedBuildIds: ['one', 'two'],
        observedBuildIds: ['one'],
        shards: [
          {
            buildId: 'one',
            name: 'one.jsonl.gz',
            sha256: 'a'.repeat(64),
            bytes: 12,
            rows: 1,
            complete: true,
          },
        ],
      }),
    )
    await writeBuck2CacheProofReports({ ...options, shardIndexPath })
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(proof.shardIndex.shardCount).toBe(1)
    expect(proof.shardIndex.invocationCount).toBe(2)
    expect(proof.evidenceGaps).toContain('shard-index-incomplete')
    expect(proof.accepted).toBe(false)
  })

  it('bounds total manifest references instead of allowing the per-observation product', async () => {
    const options = await setup()
    await put(options.summaryPath, options.actionsPath, artifactFixture())
    const manifestPath = join(options.root, 'oversized-history.json')
    await Bun.write(manifestPath, JSON.stringify(manifestFixture(['main-reader', 'pr'], 43)))
    await writeBuck2CacheProofReports({ ...options, manifestPath })
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(proof.accepted).toBe(false)
    expect(proof.historicalManifestSha256).toBeNull()
    expect(proof.evidenceGaps).toContain('historical-manifest-unavailable-or-invalid')
  })

  it('binds only chronological first command identities per root, never kind10 repetitions', async () => {
    const options = await setup()
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const reader = item.readers[0]!
      const ids = [0, 1, 2, 3].map((index) => `${item.observation.id}-build-${index}`)
      const actions = ids.map((buildId, index) =>
        actionFixture({
          buildId,
          identifier: '',
          startedAt: 200 + index * 10,
          completedAt: 202 + index * 10,
          endTime: 202 + index * 10,
          executionKind: index === 3 ? 10 : 3,
          outcome: index === 3 ? 'local-cache' : 'remote-hit',
          cacheOutcome: index === 3 ? 'local-cache' : 'remote-hit',
        }),
      )
      const actual = artifactFixture(false, actions)
      const template = actual.header.invocations[0]!
      actual.header.invocations = ids.map((buildId, index) =>
        Object.assign({}, template, {
          buildId,
          startedAt: 200 + index * 10,
          completedAt: 205 + index * 10,
          freshRoot: index === 0 || index === 2,
          actionCount: 1,
          rootId: index < 2 ? 'a'.repeat(64) : 'b'.repeat(64),
        }),
      )
      await put(
        join(options.root, item.observation.writers[0]!.summary),
        join(options.root, item.observation.writers[0]!.actions),
        item.writers[0]!,
      )
      await put(
        join(options.root, item.observation.readers[0]!.summary),
        join(options.root, item.observation.readers[0]!.actions),
        actual,
      )
      expect(reader.header.metadata.lane).toBe('main-reader')
    }
    await put(options.summaryPath, options.actionsPath, artifactFixture())
    const manifestPath = join(options.root, 'history.json')
    await Bun.write(manifestPath, JSON.stringify(manifest))
    await writeBuck2CacheProofReports({ ...options, manifestPath })
    const proof = await Bun.file(join(options.root, proofManifestName)).json()
    expect(
      proof.writerPriorUploadBindings[0].invocations.map(
        (item: { writers: unknown[] }) => item.writers.length,
      ),
    ).toEqual([1, 0, 1, 0])
    expect(proof.references[1].invocations[0].rootId).toBe('a'.repeat(64))
    expect(proof.references[1].invocations[0].buildId).toBe('observation-0-build-0')
    expect(proof.references[1].metadata.repo).toBe('public/test')
    expect(proof.references[1].metadata.cacheOutcomeMapping).toBe(
      'effect-utils/compact-cache-outcome/v1',
    )
  })
})
