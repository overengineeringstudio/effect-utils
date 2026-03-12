import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
  const pkg = (name: string, memberPath: string): WorkspacePackageLike => ({
    data: { name },
    meta: {
      workspace: {
        repoName: 'effect-utils',
        memberPath,
        deps: [],
      },
    },
  })

  it('projects references from package metadata', () => {
    const result = tsconfigJsonFromPackages({
      dir: '/workspace/repo',
      packages: [pkg('@pkg/a', 'packages/a'), pkg('@pkg/b', 'packages/b')],
      files: [],
    })

    expect(result.data.references).toEqual([
      { path: './packages/a' },
      { path: './packages/b' },
    ])
  })

  it('includes extra references', () => {
    const result = tsconfigJsonFromPackages({
      dir: '/workspace/repo',
      packages: [pkg('@pkg/a', 'packages/a')],
      extraReferences: ['apps/service-worker'],
      files: [],
    })

    expect(result.data.references).toEqual([
      { path: './apps/service-worker' },
      { path: './packages/a' },
    ])
  })

  it('can filter to existing tsconfig files only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'genie-tsconfig-'))

    try {
      mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true })
      mkdirSync(path.join(dir, 'packages', 'b'), { recursive: true })
      mkdirSync(path.join(dir, 'apps', 'service-worker'), { recursive: true })
      mkdirSync(path.join(dir, 'packages', 'a', 'tsconfig.json'))
    } catch {}

    try {
      const result = tsconfigJsonFromPackages({
        dir,
        packages: [pkg('@pkg/a', 'packages/a'), pkg('@pkg/b', 'packages/b')],
        extraReferences: ['apps/service-worker'],
        onlyExistingReferences: true,
        files: [],
      })

      expect(result.data.references).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
