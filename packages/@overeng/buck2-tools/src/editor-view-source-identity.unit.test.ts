import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import {
  editorViewAdmissionTiming,
  editorViewSourceIdentity,
  editorViewSourceIdentityMatches,
} from './editor-view-source-identity.ts'

for (const contents of ['export default 2\n', 'export default 22\n']) {
  it.each(['file', 'directory'] as const)(
    `re-hashes an external-only %s after a ${contents.length}-byte rewrite with mtime restored`,
    (kind) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-source-identity-')))
      try {
        const admitted = join(root, 'admitted')
        const external = join(root, 'external')
        mkdirSync(admitted)
        mkdirSync(external)
        const payload = join(external, 'index.js')
        writeFileSync(payload, 'export default 1\n')
        const link = join(admitted, 'dependency')
        symlinkSync(kind === 'file' ? payload : external, link)
        const options = {
          repoRoot: root,
          editorInputs: admitted,
          nodeModules: admitted,
          backingRoots: [],
        }
        const prehash = editorViewSourceIdentity({ options })
        const status = statSync(payload, { bigint: true })
        const clock = prehash.clocks.get(status.dev) ?? status.ctimeNs
        // Use filesystem time only; an unprobed device already requires all bytes.
        utimesSync(payload, 100, Number(clock / 1_000_000_000n + 1n))
        const identity = editorViewSourceIdentity({ options, priorClocks: prehash.clocks })
        expect(identity.rehashedFiles).toBe(1)
        expect(editorViewSourceIdentityMatches({ options, identity })).toBe(true)
        const before = statSync(payload, { bigint: true })
        const spelling = readlinkSync(link)
        writeFileSync(payload, contents)
        utimesSync(payload, before.atime, before.mtime)
        const after = statSync(payload, { bigint: true })
        expect(after.mtimeNs).toBe(before.mtimeNs)
        expect(readlinkSync(link)).toBe(spelling)
        const fenced = editorViewSourceIdentity({ options, priorClocks: identity.clocks })
        expect(fenced.rehashedFiles).toBe(1)
        expect(fenced.digest).not.toBe(identity.digest)
        expect(editorViewSourceIdentityMatches({ options, identity })).toBe(false)
        console.info(
          '[source-identity-racy-test]',
          JSON.stringify({
            kind,
            sameSize: after.size === before.size,
            sameTick: after.ctimeNs === before.ctimeNs,
            rehashedFiles: fenced.rehashedFiles,
          }),
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
}

it('reports first and warm inventory re-hash costs on a 128-file fixture', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-source-cost-')))
  try {
    const admitted = join(root, 'admitted')
    mkdirSync(admitted)
    for (let index = 0; index < 128; index++)
      writeFileSync(join(admitted, `${index}.js`), 'export default 1\n')
    const options = { repoRoot: root, editorInputs: admitted, nodeModules: admitted }
    for (const phase of ['first', 'warm']) {
      const started = performance.now()
      const identity = editorViewSourceIdentity({ options })
      const admittedAt = performance.now()
      const fenced = editorViewSourceIdentity({ options, priorClocks: identity.clocks })
      const fencedAt = performance.now()
      expect(fenced.digest).toBe(identity.digest)
      console.info(
        '[source-identity-cost]',
        JSON.stringify({
          phase,
          files: 128,
          prehashRehashedFiles: identity.rehashedFiles,
          fencedRehashedFiles: fenced.rehashedFiles,
          prehashMs: admittedAt - started,
          fencedMs: fencedAt - admittedAt,
        }),
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps two consecutive warm publication admissions unchanged with zero file re-hashes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-warm-probe-')))
  try {
    writeFileSync(join(root, 'index.js'), 'export default 1\n')
    const options = { repoRoot: root, editorInputs: root, nodeModules: root }
    let warm = editorViewSourceIdentity({ options })
    // Advance the filesystem clock through real probes, never sleeps or wall-clock time.
    for (let attempt = 0; warm.rehashedFiles !== 0 && attempt < 1000; attempt++)
      warm = editorViewSourceIdentity({ options })
    expect(warm.rehashedFiles).toBe(0)
    for (let publication = 0; publication < 2; publication++) {
      const before = statSync(root, { bigint: true })
      const identity = editorViewSourceIdentity({ options })
      const after = statSync(root, { bigint: true })
      const fenced = editorViewSourceIdentity({ options, priorClocks: identity.clocks })
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(after.ctimeNs).toBe(before.ctimeNs)
      expect(identity.rehashedFiles).toBe(0)
      expect(fenced.rehashedFiles).toBe(0)
      expect(fenced.digest).toBe(identity.digest)
      expect(editorViewSourceIdentityMatches({ options, identity })).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('classifies symlinked repository and temporary roots without exposing paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-classes-')))
  const previous = process.env.TMPDIR
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    symlinkSync(root, join(root, 'tmp-link'))
    symlinkSync(repo, join(root, 'repo-link'))
    process.env.TMPDIR = join(root, 'tmp-link')
    const options = { repoRoot: join(root, 'repo-link'), editorInputs: repo, nodeModules: root }
    const check = editorViewSourceIdentity({ options, priorClocks: new Map() })
    expect([...check.devices.values()].map((device) => device.rootClass).sort()).toEqual([
      'repo',
      'tmp',
    ])
    for (const device of check.devices.values())
      expect(['/nix/store', '/home/runner/work', '/tmp', '/private/tmp', 'other']).toContain(
        device.pathPrefix,
      )
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it('emits admission counters in the replay-deduplicable editor-view timing line', () => {
  const device = { device: '1', rootClass: 'repo', probed: true, pathPrefix: '/tmp' }
  const devices = new Map([['1:repo', device]])
  const check = { digest: 'proof', clocks: new Map(), rehashedFiles: 2, hashedBytes: 17, devices }
  const fields = {
    package: 'fixture',
    admissionId: 'invocation-1',
    durationMs: 9,
    fenceMismatches: 1,
    proofRebuilds: 1,
    innerLockWaitMs: 3,
  }
  const line = editorViewAdmissionTiming({ ...fields, prehash: [check], fenced: [check] })
  expect(JSON.parse(line.replace(/^\[editor-view-timing\] /, ''))).toMatchObject({
    ...fields,
    prehashRehashedFiles: 2,
    fencedRehashedFiles: 2,
    hashedBytes: 34,
    probedDevices: [{ device: '1', rootClass: 'repo', probed: true }],
  })
})
