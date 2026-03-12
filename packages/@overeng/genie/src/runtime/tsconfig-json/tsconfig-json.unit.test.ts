import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tsconfigJson, tsconfigJsonFromPackages, type GenieContext } from '../mod.ts'
import type { WorkspacePackageLike } from '../package-json/mod.ts'

const mockGenieContext: GenieContext = {
  location: 'packages/@test/package',
  cwd: '/workspace',
}

describe('tsconfigJson', () => {
  it('returns GenieOutput with data and stringify', () => {
    const result = tsconfigJson({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
      },
      include: ['src/**/*.ts'],
    })

    expect(result.data).toEqual({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
      },
      include: ['src/**/*.ts'],
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON', () => {
    const result = tsconfigJson({
      compilerOptions: {
        strict: true,
      },
      include: ['src/**/*.ts'],
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.compilerOptions.strict).toBe(true)
    expect(parsed.include).toEqual(['src/**/*.ts'])
  })

  describe('extends warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('logs warning when extends is provided', () => {
      tsconfigJson({
        extends: '../tsconfig.base.json',
        compilerOptions: { strict: true },
      })

      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extends'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not recommended'))
    })

    it('logs warning when extends is an array', () => {
      tsconfigJson({
        extends: ['../tsconfig.base.json', '../tsconfig.node.json'],
        compilerOptions: { strict: true },
      })

      expect(warnSpy).toHaveBeenCalledOnce()
    })

    it('does not log warning when extends is not provided', () => {
      tsconfigJson({
        compilerOptions: { strict: true },
        include: ['src/**/*.ts'],
      })

      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})

describe('tsconfigJsonFromPackages', () => {
  const createTempRepo = () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'genie-tsconfig-'))
    mkdirSync(path.join(repoRoot, '.git'))
    return repoRoot
  }

  const pkg = (repoName: string, name: string, memberPath: string): WorkspacePackageLike => ({
    data: { name },
    meta: {
      workspace: {
        repoName,
        memberPath,
        deps: [],
      },
    },
  })

  it('projects references from package metadata', () => {
    const dir = createTempRepo()

    try {
      const repoName = path.basename(dir)
      const result = tsconfigJsonFromPackages({
        dir,
        packages: [pkg(repoName, '@pkg/a', 'packages/a'), pkg(repoName, '@pkg/b', 'packages/b')],
        files: [],
      })

      expect(result.data.references).toEqual([{ path: './packages/a' }, { path: './packages/b' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes extra references', () => {
    const dir = createTempRepo()

    try {
      const repoName = path.basename(dir)
      const result = tsconfigJsonFromPackages({
        dir,
        packages: [pkg(repoName, '@pkg/a', 'packages/a')],
        extraReferences: ['apps/service-worker'],
        files: [],
      })

      expect(result.data.references).toEqual([
        { path: './apps/service-worker' },
        { path: './packages/a' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('excludes foreign repo packages from projected references', () => {
    const dir = createTempRepo()

    try {
      const repoName = path.basename(dir)
      const result = tsconfigJsonFromPackages({
        dir,
        packages: [
          pkg(repoName, '@pkg/a', 'packages/a'),
          pkg(repoName, '@pkg/b', 'packages/b'),
          pkg('foreign-repo', '@foreign/c', 'packages/c'),
        ],
        files: [],
      })

      expect(result.data.references).toEqual([{ path: './packages/a' }, { path: './packages/b' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('can filter to existing tsconfig files only', () => {
    const dir = createTempRepo()

    try {
      const repoName = path.basename(dir)
      mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true })
      mkdirSync(path.join(dir, 'packages', 'b'), { recursive: true })
      mkdirSync(path.join(dir, 'apps', 'service-worker'), { recursive: true })
      writeFileSync(path.join(dir, 'packages', 'a', 'tsconfig.json'), '{}\n')
      const result = tsconfigJsonFromPackages({
        dir,
        packages: [pkg(repoName, '@pkg/a', 'packages/a'), pkg(repoName, '@pkg/b', 'packages/b')],
        extraReferences: ['apps/service-worker'],
        onlyExistingReferences: true,
        files: [],
      })

      expect(result.data.references).toEqual([{ path: './packages/a' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
