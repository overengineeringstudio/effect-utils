import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tsconfigReferencesFromPackages } from '../composition/mod.ts'
import { tsconfigJson, type GenieContext } from '../mod.ts'
import { tsconfigJsonFromPackages } from '../node/mod.ts'
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

  describe('workspace reference validation', () => {
    const workspacePackages = [
      {
        name: '@test/app',
        path: 'packages/app',
        dependencies: { '@test/lib': 'workspace:^' },
        devDependencies: {},
      },
      {
        name: '@test/lib',
        path: 'packages/lib',
        dependencies: {},
        devDependencies: {},
      },
    ]

    const context = ({ tsconfig }: { tsconfig: string }): GenieContext => ({
      location: 'packages/app',
      cwd: '/workspace',
      workspace: {
        packages: workspacePackages,
        byName: new Map(workspacePackages.map((pkg) => [pkg.name, pkg])),
      },
      io: {
        fileExists: (filePath) => filePath === '/workspace/packages/lib/tsconfig.json',
        readText: (filePath) =>
          filePath === '/workspace/packages/lib/tsconfig.json' ? tsconfig : undefined,
      },
      parseJsonc: ({ text }) => JSON.parse(text),
    })

    it('requires references for workspace deps that can be project reference targets', () => {
      const result = tsconfigJson({ compilerOptions: {}, include: ['src/**/*.ts'] })

      expect(
        result.validate?.(
          context({
            tsconfig: JSON.stringify({ compilerOptions: { composite: true } }),
          }),
        ),
      ).toEqual([
        {
          severity: 'error',
          packageName: '@test/app',
          dependency: '@test/lib',
          message: 'Missing tsconfig reference "../lib" for workspace dependency "@test/lib"',
          rule: 'tsconfig-references',
        },
      ])
    })

    it('skips workspace deps whose tsconfig disables emit', () => {
      const result = tsconfigJson({ compilerOptions: {}, include: ['src/**/*.ts'] })

      expect(
        result.validate?.(
          context({
            tsconfig: JSON.stringify({ compilerOptions: { composite: true, noEmit: true } }),
          }),
        ),
      ).toEqual([])
    })

    it.each([
      { location: 'apps/app', target: 'apps/app/packages/lib' },
      { location: '.', target: 'packages/lib' },
      { location: 'apps/app', target: '.' },
      { location: './apps/app/', target: './apps/app/packages/./lib' },
      { location: './', target: 'packages/lib' },
    ])('accepts projected references from $location to $target', ({ location, target }) => {
      const lib: WorkspacePackageLike = {
        data: { name: '@test/lib' },
        meta: { workspace: { repoName: 'repo', memberPath: target, deps: [] } },
      }
      const app: WorkspacePackageLike = {
        data: { name: '@test/app' },
        meta: { workspace: { repoName: 'repo', memberPath: location, deps: [lib] } },
      }
      const packages = [
        { ...workspacePackages[0]!, path: location },
        { ...workspacePackages[1]!, path: target },
      ]
      const ctx: GenieContext = {
        ...context({ tsconfig: '{"compilerOptions":{"composite":true}}' }),
        location,
        workspace: { packages, byName: new Map(packages.map((pkg) => [pkg.name, pkg])) },
        io: {
          fileExists: (filePath) => filePath === `/workspace/${target}/tsconfig.json`,
          readText: (filePath) =>
            filePath === `/workspace/${target}/tsconfig.json`
              ? '{"compilerOptions":{"composite":true}}'
              : undefined,
        },
      }

      const references = tsconfigReferencesFromPackages({ from: app })
      expect(tsconfigJson({ references }).validate?.(ctx)).toEqual([])
      expect(tsconfigJson({ references: [] }).validate?.(ctx)).toMatchObject([
        { rule: 'tsconfig-references', dependency: '@test/lib' },
      ])
    })

    it.each(['../lib', './../lib/', '../app/../lib', '../lib//.'])(
      'accepts equivalent relative reference %s',
      (reference) => {
        expect(
          tsconfigJson({ references: [{ path: reference }] }).validate?.(
            context({ tsconfig: '{"compilerOptions":{"composite":true}}' }),
          ),
        ).toEqual([])
      },
    )

    it.each(['../../lib', './lib', '../lib/../../lib'])(
      'rejects references to a different directory: %s',
      (reference) => {
        expect(
          tsconfigJson({ references: [{ path: reference }] }).validate?.(
            context({ tsconfig: '{"compilerOptions":{"composite":true}}' }),
          ),
        ).toMatchObject([{ rule: 'tsconfig-references', dependency: '@test/lib' }])
      },
    )
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
        repoName,
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
        repoName,
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
        repoName,
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
        repoName,
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
