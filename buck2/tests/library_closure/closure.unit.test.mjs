import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('deduplicates repeated edges and retains two versions with a stable primary', () => {
  const work = mkdtempSync(join(tmpdir(), 'effect-utils-library-closure-'))
  try {
    const names = ['libroot-hash.rlib', 'libdependency-one.rlib', 'libdependency-two.rlib']
    const artifacts = names.map((name) => {
      const path = join(work, name)
      writeFileSync(path, name)
      return [path, name.startsWith('libroot') ? 'root' : 'dependency', null, 'link']
    })
    const manifest = join(work, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({
      primary: artifacts[0][0], artifacts: [...artifacts, artifacts[1], artifacts[0]],
      targetTriple: 'x86_64-unknown-linux-gnu', hostTriple: 'x86_64-unknown-linux-gnu',
      panicStrategy: 'unwind',
    }))
    const rustc = join(work, 'rustc')
    writeFileSync(rustc, `#!/bin/sh\nprintf '%s\\n' '{"verboseVersion":"host: x86_64-unknown-linux-gnu\\n","darwinWrapperEvidence":""}'\n`)
    chmodSync(rustc, 0o755)
    const result = Bun.spawnSync({ cmd: [process.execPath,
      fileURLToPath(new URL('../../rust/library-closure.mjs', import.meta.url)),
      manifest, join(work, 'lib'), join(work, 'metadata.json'), rustc], stderr: 'pipe' })
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    expect(readdirSync(join(work, 'lib')).sort()).toEqual(['libdependency-one.rlib', 'libdependency-two.rlib', 'libroot.rlib'])
    expect(readFileSync(join(work, 'lib/libroot.rlib'), 'utf8')).toBe(names[0])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
