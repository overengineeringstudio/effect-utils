import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { defineRepoContext, repoRootFromModuleUrl } from './mod.ts'

const createRepoFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'genie-repo-context-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'genie'), { recursive: true })
  mkdirSync(join(root, 'release'), { recursive: true })
  writeFileSync(join(root, 'genie', 'repo.ts'), '')
  writeFileSync(join(root, 'release', 'version.json'), JSON.stringify({ version: '1.2.3' }))
  return { root, moduleUrl: pathToFileURL(join(root, 'genie', 'repo.ts')).href }
}

describe('repo context', () => {
  it('finds the repository root from a generator module URL', () => {
    const fixture = createRepoFixture()

    expect(repoRootFromModuleUrl(fixture.moduleUrl)).toBe(fixture.root)
  })

  it('reads repo-local files independent of process cwd', () => {
    const fixture = createRepoFixture()
    const previousCwd = process.cwd()
    process.chdir(tmpdir())
    try {
      const repo = defineRepoContext({
        name: 'example',
        importMetaUrl: fixture.moduleUrl,
      })

      expect(repo.name).toBe('example')
      expect(repo.rootPath).toBe(fixture.root)
      expect(repo.readJson<{ readonly version: string }>('release/version.json')).toEqual({
        version: '1.2.3',
      })
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('recovers the repo root from Genie temp import mirror paths', () => {
    const fixture = createRepoFixture()
    const mirroredModulePath = join(
      mkdtempSync(join(tmpdir(), 'genie-import-')),
      fixture.root.slice(1),
      'genie',
      'repo.ts',
    )
    mkdirSync(join(mirroredModulePath, '..'), { recursive: true })
    writeFileSync(mirroredModulePath, '')

    expect(repoRootFromModuleUrl(pathToFileURL(mirroredModulePath).href)).toBe(fixture.root)
  })
})
