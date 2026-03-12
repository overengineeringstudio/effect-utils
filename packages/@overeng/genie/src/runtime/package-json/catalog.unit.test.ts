import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CatalogConflictError, defineCatalog } from './catalog.ts'
import { packageJson } from './mod.ts'

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-workspace-'))
  fs.mkdirSync(path.join(repoRoot, '.git'))

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    memberDirs: Object.fromEntries(
      memberPaths.map((memberPath) => {
        const memberDir = path.join(repoRoot, memberPath)
        fs.mkdirSync(memberDir, { recursive: true })
        return [memberPath, memberDir]
      }),
    ) as Record<string, string>,
  }
}

describe('defineCatalog', () => {
  describe('standalone catalog', () => {
    it('returns frozen catalog object', () => {
      const catalog = defineCatalog({
        effect: '3.19.14',
        '@effect/platform': '0.94.1',
      })

      expect(catalog.effect).toBe('3.19.14')
      expect(catalog['@effect/platform']).toBe('0.94.1')
      expect(Object.isFrozen(catalog)).toBe(true)
    })

    it('preserves all entries', () => {
      const catalog = defineCatalog({
        a: '1.0.0',
        b: '2.0.0',
        c: '3.0.0',
      })

      expect(Object.keys(catalog)).toHaveLength(3)
    })
  })

  describe('extended catalog', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      '@effect/platform': '0.94.1',
      react: '19.2.3',
    })

    it('merges base catalog with new packages', () => {
      const extended = defineCatalog({
        extends: baseCatalog,
        packages: {
          '@effect/ai-openai': '0.37.2',
          typescript: '5.9.3',
        },
      })

      expect(extended.effect).toBe('3.19.14')
      expect(extended['@effect/platform']).toBe('0.94.1')
      expect(extended.react).toBe('19.2.3')
      expect(extended['@effect/ai-openai']).toBe('0.37.2')
      expect(extended.typescript).toBe('5.9.3')
    })

    it('returns frozen object', () => {
      const extended = defineCatalog({
        extends: baseCatalog,
        packages: { newPkg: '1.0.0' },
      })

      expect(Object.isFrozen(extended)).toBe(true)
    })
  })

  describe('duplicate detection (same version)', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      react: '19.2.3',
    })

    it('warns on duplicate and includes the package', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const extended = defineCatalog({
        extends: baseCatalog,
        packages: {
          effect: '3.19.14', // same version as base
          newPkg: '1.0.0',
        },
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate: "effect@3.19.14" already defined'),
      )
      expect(extended.effect).toBe('3.19.14')
      expect(extended.newPkg).toBe('1.0.0')

      warnSpy.mockRestore()
    })

    it('warns for each duplicate', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      defineCatalog({
        extends: baseCatalog,
        packages: {
          effect: '3.19.14',
          react: '19.2.3',
        },
      })

      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('effect@3.19.14'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('react@19.2.3'))

      warnSpy.mockRestore()
    })
  })

  describe('conflict detection (different version)', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      react: '19.2.3',
    })

    it('throws CatalogConflictError on version mismatch', () => {
      expect(() =>
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0', // different version
          },
        }),
      ).toThrow(CatalogConflictError)
    })

    it('includes both versions in error message', () => {
      try {
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
          },
        })
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CatalogConflictError)
        const error = err as CatalogConflictError
        expect(error.packageName).toBe('effect')
        expect(error.baseVersion).toBe('3.19.14')
        expect(error.newVersion).toBe('3.20.0')
        expect(error.message).toContain('3.19.14')
        expect(error.message).toContain('3.20.0')
      }
    })

    it('throws on first conflict encountered', () => {
      expect(() =>
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
            react: '18.0.0', // also conflicting
          },
        }),
      ).toThrow('effect')
    })
  })

  describe('multiple extends', () => {
    const catalogA = defineCatalog({
      effect: '3.19.14',
      '@effect/platform': '0.94.1',
    })

    const catalogB = defineCatalog({
      react: '19.2.3',
      typescript: '5.9.3',
    })

    it('merges multiple base catalogs', () => {
      const merged = defineCatalog({
        extends: [catalogA, catalogB],
        packages: {
          vitest: '4.0.16',
        },
      })

      expect(merged.effect).toBe('3.19.14')
      expect(merged['@effect/platform']).toBe('0.94.1')
      expect(merged.react).toBe('19.2.3')
      expect(merged.typescript).toBe('5.9.3')
      expect(merged.vitest).toBe('4.0.16')
    })

    it('throws on conflict between base catalogs', () => {
      const catalogConflicting = defineCatalog({
        effect: '3.20.0', // conflicts with catalogA
      })

      expect(() =>
        defineCatalog({
          extends: [catalogA, catalogConflicting],
          packages: {},
        }),
      ).toThrow(CatalogConflictError)
    })

    it('allows same version across multiple bases', () => {
      const catalogDuplicate = defineCatalog({
        effect: '3.19.14', // same as catalogA
      })

      const merged = defineCatalog({
        extends: [catalogA, catalogDuplicate],
        packages: {},
      })

      expect(merged.effect).toBe('3.19.14')
    })
  })

  describe('type safety', () => {
    it('preserves literal types in standalone catalog', () => {
      const catalog = defineCatalog({
        effect: '3.19.14',
        react: '19.2.3',
      } as const)

      // Type assertion - this should compile
      const _effect: '3.19.14' = catalog.effect
      const _react: '19.2.3' = catalog.react
      expect(_effect).toBe('3.19.14')
      expect(_react).toBe('19.2.3')
    })

    it('merged catalog has union of keys', () => {
      const base = defineCatalog({ a: '1.0.0' })
      const extended = defineCatalog({
        extends: base,
        packages: { b: '2.0.0' },
      })

      // Both keys should be accessible
      expect(extended.a).toBe('1.0.0')
      expect(extended.b).toBe('2.0.0')
    })
  })

  describe('edge cases', () => {
    it('handles empty packages in extended catalog', () => {
      const base = defineCatalog({ effect: '3.19.14' })
      const extended = defineCatalog({
        extends: base,
        packages: {},
      })

      expect(extended.effect).toBe('3.19.14')
      expect(Object.keys(extended)).toHaveLength(1)
    })

    it('handles empty base catalog', () => {
      const base = defineCatalog({})
      const extended = defineCatalog({
        extends: base,
        packages: { effect: '3.19.14' },
      })

      expect(extended.effect).toBe('3.19.14')
    })

    it('handles scoped package names correctly', () => {
      const catalog = defineCatalog({
        '@effect/platform': '0.94.1',
        '@types/node': '25.0.3',
      })

      expect(catalog['@effect/platform']).toBe('0.94.1')
      expect(catalog['@types/node']).toBe('25.0.3')
    })
  })

  describe('compose', () => {
    const catalog = defineCatalog({
      '@effect/platform': '0.94.1',
      effect: '3.19.14',
      react: '19.2.3',
    })
    const repo = createTempRepo('packages/utils', 'packages/core', 'packages/app')

    it('derives emitted dependencies and workspace metadata from imported packages', () => {
      const utilsComposition = catalog.compose({
        dir: repo.memberDirs['packages/utils']!,
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )
      const coreComposition = catalog.compose({
        dir: repo.memberDirs['packages/core']!,
        dependencies: {
          workspace: [utils],
        },
      })
      const core = packageJson(
        {
          name: '@test/core',
          version: '1.0.0',
        },
        coreComposition,
      )

      const appDir = repo.memberDirs['packages/app']!

      const composed = catalog.compose({
        dir: appDir,
        dependencies: {
          workspace: [core],
          external: catalog.pick('effect', 'react'),
        },
      })

      expect(composed.dependencies).toEqual({
        '@test/core': 'workspace:*',
        effect: '3.19.14',
        react: '19.2.3',
      })
      expect(composed.workspace).toEqual({
        repoName: repo.repoName,
        memberPath: 'packages/app',
        deps: [core],
      })
    })

    it('installs inherited peers explicitly in install mode', () => {
      const utilsComposition = catalog.compose({
        dir: repo.memberDirs['packages/utils']!,
        peerDependencies: {
          external: catalog.pick('effect', '@effect/platform'),
        },
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )

      const appDir = repo.memberDirs['packages/app']!

      const composed = catalog.compose({
        dir: appDir,
        dependencies: {
          workspace: [utils],
          external: catalog.pick('react'),
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@effect/platform': '0.94.1',
        '@test/utils': 'workspace:*',
        effect: '3.19.14',
        react: '19.2.3',
      })
    })

    it('collects inherited peers transitively in install mode', () => {
      const utilsComposition = catalog.compose({
        dir: repo.memberDirs['packages/utils']!,
        peerDependencies: {
          external: catalog.pick('effect'),
        },
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )
      const coreComposition = catalog.compose({
        dir: repo.memberDirs['packages/core']!,
        dependencies: {
          workspace: [utils],
        },
      })
      const core = packageJson(
        {
          name: '@test/core',
          version: '1.0.0',
        },
        coreComposition,
      )

      const appDir = repo.memberDirs['packages/app']!

      const composed = catalog.compose({
        dir: appDir,
        dependencies: {
          workspace: [core],
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@test/core': 'workspace:*',
        effect: '3.19.14',
      })
    })

    it('throws when install mode cannot resolve an inherited peer version', () => {
      const appComposition = catalog.compose({
        dir: repo.memberDirs['packages/app']!,
        peerDependencies: {
          external: {
            missing: '1.0.0',
          },
        },
      })
      const app = packageJson(
        {
          name: '@test/app',
          version: '1.0.0',
        },
        appComposition,
      )

      const appDir = repo.memberDirs['packages/app']!

      expect(() =>
        catalog.compose({
          dir: appDir,
          dependencies: {
            workspace: [app],
          },
          mode: 'install',
        }),
      ).toThrow('Catalog is missing explicit install version for inherited peer "missing"')
    })

    it('returns empty workspace metadata when no workspace packages are provided', () => {
      const appDir = repo.memberDirs['packages/app']!

      const composed = catalog.compose({
        dir: appDir,
        dependencies: {
          external: catalog.pick('effect'),
        },
      })

      expect(composed.dependencies).toEqual({
        effect: '3.19.14',
      })
      expect(composed.workspace).toEqual({
        repoName: repo.repoName,
        memberPath: 'packages/app',
        deps: [],
      })
    })
  })
})
