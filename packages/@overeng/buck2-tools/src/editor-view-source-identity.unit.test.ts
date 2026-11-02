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
