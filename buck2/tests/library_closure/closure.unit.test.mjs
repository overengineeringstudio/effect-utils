import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rejects = ({ artifacts, diagnostic }) => {
  const work = mkdtempSync(join(tmpdir(), 'effect-utils-library-negative-'))
  try {
    const manifest = join(work, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ primary: '/primary.rlib', artifacts }))
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL('../../rust/library-closure.mjs', import.meta.url)),
        manifest,
        join(work, 'lib'),
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(diagnostic)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

test('rejects fast metadata', () =>
  rejects({
    artifacts: [['/check.rmeta', 'check', null, 'fast']],
    diagnostic: 'Unsupported metadata role: fast',
  }))
test('rejects distinct artifacts at one flat destination', () =>
  rejects({
    artifacts: [
      ['/first/libdependency-hash.rlib', 'dependency', null, 'link'],
      ['/second/libdependency-hash.rlib', 'dependency', null, 'link'],
    ],
    diagnostic: 'Flat destination collision libdependency-hash.rlib',
  }))
