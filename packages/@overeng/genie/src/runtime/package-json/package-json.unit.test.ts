import { describe, expect, it } from 'vitest'

import {
  packageJson,
  workspaceRoot,
  type GenieContext,
  type GenieValidationContext,
  type PackageInfo,
} from '../mod.ts'

/** Mock GenieContext for package tests (nested package location) */
const mockGenieContext: GenieContext = {
  location: 'packages/@test/package',
  cwd: '/workspace',
}

/** Mock GenieContext for workspace root tests (repo root location) */
const mockWorkspaceRootContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

describe('packageJson', () => {
  it('returns GenieOutput with data and stringify', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
    })

    expect(result.data).toEqual({
      name: '@test/package',
      version: '1.0.0',
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON with $genie marker', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.$genie).toBe(true)
    expect(parsed.name).toBe('@test/package')
    expect(parsed.version).toBe('1.0.0')
  })

  it('sorts dependencies alphabetically', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      dependencies: {
        zlib: '1.0.0',
        axios: '2.0.0',
        effect: '3.0.0',
      },
    })

    const json = result.stringify(mockGenieContext)
    const keys = Object.keys(JSON.parse(json).dependencies)
    expect(keys).toEqual(['axios', 'effect', 'zlib'])
  })

  it('sorts fields in conventional order', () => {
    const result = packageJson({
      dependencies: { effect: '3.0.0' },
      name: '@test/package',
      exports: { '.': './src/mod.ts' },
      version: '1.0.0',
      type: 'module',
    })

    const json = result.stringify(mockGenieContext)
    const keys = Object.keys(JSON.parse(json))

    const genieIdx = keys.indexOf('$genie')
    const nameIdx = keys.indexOf('name')
    const versionIdx = keys.indexOf('version')
    const typeIdx = keys.indexOf('type')
    const exportsIdx = keys.indexOf('exports')
    const depsIdx = keys.indexOf('dependencies')

    // Verify order: $genie < name < version < type < exports < dependencies
    expect(genieIdx).toBeLessThan(nameIdx)
    expect(nameIdx).toBeLessThan(versionIdx)
    expect(versionIdx).toBeLessThan(typeIdx)
    expect(typeIdx).toBeLessThan(exportsIdx)
    expect(exportsIdx).toBeLessThan(depsIdx)
  })

  it('sorts export conditions (types first, default last)', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': {
          default: './dist/mod.js',
          types: './dist/mod.d.ts',
          import: './dist/mod.mjs',
        },
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)
    const conditions = Object.keys(parsed.exports['.'])
    expect(conditions).toEqual(['types', 'import', 'default'])
  })

  it('sorts export paths with "." first', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        './utils': './src/utils.ts',
        '.': './src/mod.ts',
        './types': './src/types.ts',
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)
    const paths = Object.keys(parsed.exports)
    expect(paths[0]).toBe('.')
  })

  it('preserves data for composition', () => {
    const utilsPkg = packageJson({
      name: '@myorg/utils',
      version: '1.0.0',
      peerDependencies: {
        effect: '^3.0.0',
        react: '^19.0.0',
      },
    })

    // Another package can compose with this
    const appPkg = packageJson({
      name: '@myorg/app',
      version: '1.0.0',
      dependencies: {
        '@myorg/utils': 'workspace:*',
      },
      peerDependencies: {
        ...utilsPkg.data.peerDependencies,
      },
    })

    expect(appPkg.data.peerDependencies).toEqual({
      effect: '^3.0.0',
      react: '^19.0.0',
    })
  })
})

describe('packageJson with function scripts', () => {
  it('resolves function script values at stringify time', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        postinstall: (location) => `echo "location: ${location}"`,
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.scripts).toBeDefined()
    expect(parsed.scripts.postinstall).toBe('echo "location: packages/@test/package"')
  })

  it('handles mixed string and function scripts', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        build: 'tsc',
        postinstall: (location) => `patch -p1 < ../${location}/patches/foo.patch`,
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.scripts.build).toBe('tsc')
    expect(parsed.scripts.postinstall).toContain('patch -p1')
  })

  it('passes correct location to function scripts in nested packages', () => {
    const contextInNested: GenieContext = {
      location: 'packages/nested/deep',
      cwd: '/workspace',
    }

    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        setup: (location) => `echo "${location}"`,
      },
    })

    const json = result.stringify(contextInNested)
    const parsed = JSON.parse(json)

    expect(parsed.scripts.setup).toBe('echo "packages/nested/deep"')
  })
})

const makePackage = (
  overrides: Partial<PackageInfo> & { name: string; path: string },
): PackageInfo => ({
  ...overrides,
})

const makeValidationContext = (packages: PackageInfo[]): GenieValidationContext => ({
  cwd: '/workspace',
  packageJson: {
    packages,
    byName: new Map(packages.map((p) => [p.name, p])),
    workspaceProvider: {
      name: 'pnpm',
      discoverPackageJsonPaths: () => {
        throw new Error('not implemented')
      },
    },
  },
})

describe('packageJson validate hook', () => {
  it('returns a validate function', () => {
    const result = packageJson({ name: '@test/pkg', version: '1.0.0' })
    expect(typeof result.validate).toBe('function')
  })

  it('returns no issues when recomposition is correct', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson({
      name: '@test/app',
      version: '1.0.0',
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { effect: '^3.0.0' },
    })

    expect(result.validate!(ctx)).toEqual([])
  })

  it('reports issues when peer deps are missing', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson({
      name: '@test/app',
      version: '1.0.0',
      dependencies: { '@test/utils': 'workspace:*' },
    })

    const issues = result.validate!(ctx)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rule: 'recompose-peer-deps' })
  })

  it('returns empty array when name is missing', () => {
    const result = packageJson({ version: '1.0.0' })
    const ctx = makeValidationContext([])
    expect(result.validate!(ctx)).toEqual([])
  })
})

describe('workspaceRoot', () => {
  it('returns GenieOutput with data and stringify', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
      workspaces: ['packages/*'],
    })

    expect(result.data).toEqual({
      name: 'my-monorepo',
      private: true,
      workspaces: ['packages/*'],
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON with $genie marker', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)

    expect(parsed.$genie).toBe(true)
    expect(parsed.name).toBe('my-monorepo')
    expect(parsed.private).toBe(true)
  })

  it('supports workspaces configuration', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
      workspaces: ['packages/*', 'apps/*'],
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)
    expect(parsed.workspaces).toEqual(['packages/*', 'apps/*'])
  })

  it('supports pnpm namespace', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
      pnpm: {
        patchedDependencies: {
          'some-pkg@1.0.0': 'patches/some-pkg.patch',
        },
      },
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)
    expect(parsed.pnpm.patchedDependencies).toEqual({
      'some-pkg@1.0.0': 'patches/some-pkg.patch',
    })
  })

  it('supports Bun catalogs', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
      catalog: {
        effect: '3.0.0',
        react: '19.0.0',
      },
      catalogs: {
        testing: {
          vitest: '4.0.0',
        },
      },
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)
    expect(parsed.catalog).toEqual({
      effect: '3.0.0',
      react: '19.0.0',
    })
    expect(parsed.catalogs).toEqual({
      testing: {
        vitest: '4.0.0',
      },
    })
  })

  it('supports trustedDependencies', () => {
    const result = workspaceRoot({
      name: 'my-monorepo',
      private: true,
      trustedDependencies: ['esbuild', 'sharp'],
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)
    expect(parsed.trustedDependencies).toEqual(['esbuild', 'sharp'])
  })
})
