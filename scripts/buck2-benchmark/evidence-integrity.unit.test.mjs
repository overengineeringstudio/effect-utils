import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const experimentDirectory = resolve(
  import.meta.dirname,
  '../../context/dependency-materialization/05-buck2-evidence/.experiments',
)

const committedSnapshots = [
  {
    path: join(experimentDirectory, '2026-08-11-tui-core-input-plan-benchmark.summary.jsonl'),
    sha256: '965e54d17483f8f3dd1fe58b6ddfab41d04c04473e1becf603afcc3a06e0a7b5',
  },
  {
    path: join(experimentDirectory, '2026-08-11-tui-core-input-plan-watchman.summary.jsonl'),
    sha256: 'b0f6e899f42cec700935a0fe413b4b5b156e1aed04fef1c2320d1d8b328dac0d',
  },
]

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const assertSnapshotIntegrity = ({ path, sha256: expectedSha256 }) =>
  assert.equal(
    sha256(readFileSync(path)),
    expectedSha256,
    `${basename(path)} must match its reviewed immutable evidence digest`,
  )

describe('committed Buck2 benchmark evidence', () => {
  it('matches the exact reviewed snapshot digests', () => {
    for (const snapshot of committedSnapshots) assertSnapshotIntegrity(snapshot)
  })

  it('rejects a byte mutation instead of accepting structurally valid JSONL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-evidence-integrity-'))
    try {
      const [snapshot] = committedSnapshots
      const mutatedPath = join(directory, basename(snapshot.path))
      writeFileSync(mutatedPath, Buffer.concat([readFileSync(snapshot.path), Buffer.from('\n')]))

      assert.throws(
        () => assertSnapshotIntegrity({ ...snapshot, path: mutatedPath }),
        /must match its reviewed immutable evidence digest/u,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
