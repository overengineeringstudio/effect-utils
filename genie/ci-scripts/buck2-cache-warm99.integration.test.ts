import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { maxActionArtifactBytes } from './buck2-action-evidence.ts'
import {
  artifactFixture,
  encodedFixture,
  loadedFixture,
  manifestFixture,
} from './buck2-cache-warm99.fixtures.ts'
import { decodeEvidence, loadAndEvaluate } from './buck2-cache-warm99.ts'

const cli = new URL('./buck2-cache-warm99.ts', import.meta.url).pathname
describe('gzip and compact summary boundaries', () => {
  it('verifies checksum, gzip, rows, counts and metadata', () => {
    const fixture = encodedFixture(artifactFixture())
    expect(decodeEvidence(fixture.compressed, fixture.summary, 'main-reader').actions.length).toBe(
      1,
    )
    expect(() => decodeEvidence(fixture.compressed, fixture.summary, 'pr')).toThrow()
    expect(() =>
      decodeEvidence(
        fixture.compressed,
        {
          ...fixture.summary,
          actionsArtifact: { ...fixture.summary.actionsArtifact, sha256: '0'.repeat(64) },
        },
        'main-reader',
      ),
    ).toThrow()
    for (const key of ['rows', 'bytes', 'uncompressedBytes']) {
      expect(() =>
        decodeEvidence(
          fixture.compressed,
          {
            ...fixture.summary,
            actionsArtifact: { ...fixture.summary.actionsArtifact, [key]: 9999 },
          },
          'main-reader',
        ),
      ).toThrow()
    }
    expect(() =>
      decodeEvidence(fixture.compressed, { ...fixture.summary, actionCount: 9 }, 'main-reader'),
    ).toThrow()
    expect(() =>
      decodeEvidence(
        fixture.compressed,
        { ...fixture.summary, counts: { ...fixture.summary.counts, 'remote-hit': 2 } },
        'main-reader',
      ),
    ).toThrow()
    const corrupted = fixture.compressed.subarray(0, fixture.compressed.length - 5)
    const corruptedSummary = {
      ...fixture.summary,
      actionsArtifact: {
        ...fixture.summary.actionsArtifact,
        sha256: createHash('sha256').update(corrupted).digest('hex'),
      },
    }
    expect(() => decodeEvidence(corrupted, corruptedSummary, 'main-reader')).toThrow()
    const truncated = gzipSync(fixture.raw.slice(0, -1))
    expect(() =>
      decodeEvidence(
        truncated,
        {
          ...fixture.summary,
          actionsArtifact: {
            ...fixture.summary.actionsArtifact,
            sha256: createHash('sha256').update(truncated).digest('hex'),
          },
        },
        'main-reader',
      ),
    ).toThrow()
  })
})
describe('warm99 CLI manifest completeness', () => {
  it('accepts complete real files, fails missing/corrupt evidence, and emits no paths/secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-warm99-'))
    try {
      const manifest = manifestFixture()
      for (const loaded of loadedFixture(manifest)) {
        for (const [refs, artifacts] of [
          [loaded.observation.writers, loaded.writers],
          [loaded.observation.readers, loaded.readers],
        ] as const) {
          for (const [index, ref] of refs.entries()) {
            const artifact = artifacts[index]
            if (artifact === undefined) throw new Error('fixture')
            const fixture = encodedFixture(artifact)
            await Bun.write(join(directory, ref.actions), fixture.compressed)
            await Bun.write(join(directory, ref.summary), JSON.stringify(fixture.summary))
          }
        }
      }
      const manifestPath = join(directory, 'manifest.json')
      await Bun.write(manifestPath, JSON.stringify(manifest))
      expect((await loadAndEvaluate(manifestPath)).accepted).toBe(true)
      const success = Bun.spawn([process.execPath, cli, '--manifest', manifestPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const successOut = await new Response(success.stdout).text()
      expect(await success.exited).toBe(0)
      expect(successOut).toContain('"accepted":true')
      const missing = manifest.observations[1]?.readers[0]
      if (missing === undefined) throw new Error('fixture')
      missing.actions = 'missing-secret-host-file.gz'
      await Bun.write(manifestPath, JSON.stringify(manifest))
      const report = await loadAndEvaluate(manifestPath)
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.consecutive).toBe(0)
      const failure = Bun.spawn([process.execPath, cli, '--manifest', manifestPath], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GITHUB_TOKEN: 'test-secret-token' },
      })
      const out = await new Response(failure.stdout).text()
      const err = await new Response(failure.stderr).text()
      expect(await failure.exited).toBe(1)
      expect(out + err).not.toContain(directory)
      expect(out + err).not.toContain('missing-secret-host-file')
      expect(out + err).not.toContain('test-secret-token')
      await Bun.write(manifestPath, '{')
      const invalid = Bun.spawn([process.execPath, cli, '--manifest', manifestPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const invalidErr = await new Response(invalid.stderr).text()
      expect(await invalid.exited).toBe(1)
      expect(invalidErr).toBe('Warm cache evaluation failed: invalid manifest or evidence.\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('gzip expansion bound', () => {
  it('refuses an artifact larger than the producer limit plus header slack', () => {
    const fixture = encodedFixture(artifactFixture())
    const bomb = gzipSync(Buffer.alloc(maxActionArtifactBytes + 1024 * 1024 + 1, 32))
    const summary = {
      ...fixture.summary,
      actionsArtifact: {
        ...fixture.summary.actionsArtifact,
        sha256: createHash('sha256').update(bomb).digest('hex'),
        bytes: bomb.length,
      },
    }
    expect(() => decodeEvidence(bomb, summary, 'main-reader')).toThrow()
  })
})
