import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { discoverCollectableTestModules } from './typescript-package-projection.ts'

const projectionPath = fileURLToPath(new URL('./typescript-package-projection.ts', import.meta.url))
const discover = (repoRoot: string) =>
  discoverCollectableTestModules({ repoRoot, packagePath: '.', sourceRoots: ['src'] })

const withFixture = (use: (root: string) => void): void => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'genie-source-census-'))
  try {
    mkdirSync(path.join(root, 'src/tmp'), { recursive: true })
    writeFileSync(path.join(root, 'src/main.test.ts'), 'export const main = true\n')
    writeFileSync(path.join(root, 'src/tmp/ordinary.test.ts'), 'export const ordinary = true\n')
    use(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const runBun = (args: string[], cwd: string): string => {
  const result = spawnSync('bun', args, { cwd, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe('Genie output-lock state in package source roots', () => {
  it('keeps source and bundled sibling imports identical with persisted lock directories', () =>
    withFixture((root) => {
      const lockRoot = path.join(root, 'src/tmp/genie-locks')
      mkdirSync(path.join(lockRoot, encodeURIComponent('genie:file:abc123')), { recursive: true })
      writeFileSync(path.join(lockRoot, 'state.test.ts'), 'export const state = true\n')
      writeFileSync(
        path.join(root, 'sibling.ts'),
        `import { discoverCollectableTestModules } from ${JSON.stringify(projectionPath)}
export const files = discoverCollectableTestModules({ repoRoot: process.cwd(), packagePath: '.', sourceRoots: ['src'] })
`,
      )
      writeFileSync(
        path.join(root, 'BUCK.genie.ts'),
        "import { files } from './sibling.ts'\nconsole.log(JSON.stringify(files))\n",
      )
      const source = runBun(['BUCK.genie.ts'], root)
      expect(JSON.parse(source)).toEqual(['src/main.test.ts', 'src/tmp/ordinary.test.ts'])
      runBun(['build', 'BUCK.genie.ts', '--target=bun', '--outfile=bundled.js'], root)
      expect(runBun(['bundled.js'], root)).toBe(source)
    }),
  )

  it('still rejects unsafe entries outside Genie state', () =>
    withFixture((root) => {
      mkdirSync(path.join(root, 'src/tmp/unsafe%3Aname'))
      expect(() => discover(root)).toThrow('Unsafe package source path segment: unsafe%3Aname')
    }),
  )

  it('still refuses a symlink masquerading as Genie state', () =>
    withFixture((root) => {
      symlinkSync(path.join(root, 'src'), path.join(root, 'src/tmp/genie-locks'), 'dir')
      expect(() => discover(root)).toThrow('Package source census refuses symlink: src/tmp/genie-locks')
    }),
  )
})
