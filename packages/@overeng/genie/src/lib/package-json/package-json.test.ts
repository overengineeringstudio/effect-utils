import { describe, expect, it } from 'vitest'

import { createPackageJson, packageJsonWithContext } from './mod.ts'

const mockContext = {
  catalog: {
    effect: '3.19.14',
    '@effect/platform': '0.94.1',
    typescript: '5.9.3',
    vitest: '4.0.16',
    react: '19.2.3',
  },
  workspacePackages: ['@myorg/*', '@overeng/*', '@local/*'],
}

describe('packageJsonWithContext', () => {
  it('resolves catalog dependencies from string array', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: ['effect', '@effect/platform'],
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.dependencies).toEqual({
      '@effect/platform': 'catalog:',
      effect: 'catalog:',
    })
  })

  it('resolves workspace dependencies from string array', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: ['@myorg/common', '@overeng/utils'],
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.dependencies).toEqual({
      '@myorg/common': 'workspace:*',
      '@overeng/utils': 'workspace:*',
    })
  })

  it('resolves mixed catalog and workspace dependencies', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: ['effect', '@myorg/common'],
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.dependencies).toEqual({
      '@myorg/common': 'workspace:*',
      effect: 'catalog:',
    })
  })

  it('expands peer dependencies with ^ range', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        peerDependencies: { react: '^' },
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.peerDependencies).toEqual({
      react: '^19.2.3',
    })
  })

  it('expands peer dependencies with ~ range', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        peerDependencies: { react: '~' },
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.peerDependencies).toEqual({
      react: '~19.2.3',
    })
  })

  it('passes through explicit peer dependency versions', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        peerDependencies: { react: '>=18.0.0' },
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.peerDependencies).toEqual({
      react: '>=18.0.0',
    })
  })

  it('throws on unknown dependency', () => {
    expect(() =>
      packageJsonWithContext(
        {
          name: '@test/package',
          version: '1.0.0',
          dependencies: ['unknown-package'],
        },
        mockContext,
      ),
    ).toThrow('Cannot resolve dependency "unknown-package"')
  })

  it('sorts dependencies alphabetically', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: ['vitest', 'effect', '@effect/platform'],
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    const keys = Object.keys(parsed.dependencies)
    expect(keys).toEqual(['@effect/platform', 'effect', 'vitest'])
  })

  it('sorts fields in conventional order', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        exports: { '.': './src/mod.ts' },
        version: '1.0.0',
        type: 'module',
        dependencies: ['effect'],
        devDependencies: ['typescript'],
      },
      mockContext,
    )

    const keys = Object.keys(JSON.parse(result))
    const nameIdx = keys.indexOf('name')
    const versionIdx = keys.indexOf('version')
    const typeIdx = keys.indexOf('type')
    const exportsIdx = keys.indexOf('exports')
    const depsIdx = keys.indexOf('dependencies')
    const devDepsIdx = keys.indexOf('devDependencies')

    // Verify order: name < version < type < exports < dependencies < devDependencies
    expect(nameIdx).toBeLessThan(versionIdx)
    expect(versionIdx).toBeLessThan(typeIdx)
    expect(typeIdx).toBeLessThan(exportsIdx)
    expect(exportsIdx).toBeLessThan(depsIdx)
    expect(depsIdx).toBeLessThan(devDepsIdx)
  })

  it('sorts export conditions (types first, default last)', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': {
            default: './dist/mod.js',
            types: './dist/mod.d.ts',
            import: './dist/mod.mjs',
          },
        },
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    const conditions = Object.keys(parsed.exports['.'])
    expect(conditions).toEqual(['types', 'import', 'default'])
  })

  it('adds $genie marker field', () => {
    const result = packageJsonWithContext(
      {
        name: '@test/package',
        version: '1.0.0',
      },
      mockContext,
    )

    const parsed = JSON.parse(result)
    expect(parsed.$genie).toBe(true)
  })
})

describe('createPackageJson', () => {
  const catalog = {
    effect: '3.19.14',
    '@effect/platform': '0.94.1',
    react: '19.2.3',
  } as const

  const workspacePackages = ['@myorg/*', '@local/*'] as const

  const pkg = createPackageJson({ catalog, workspacePackages })

  it('generates package.json with typed dependencies', () => {
    const result = pkg({
      name: '@myorg/utils',
      version: '1.0.0',
      dependencies: ['effect', '@effect/platform'],
    })

    const parsed = JSON.parse(result)
    expect(parsed.dependencies).toEqual({
      '@effect/platform': 'catalog:',
      effect: 'catalog:',
    })
  })

  it('accepts workspace dependencies matching patterns', () => {
    const result = pkg({
      name: '@myorg/utils',
      version: '1.0.0',
      dependencies: ['effect', '@myorg/common', '@local/helpers'],
    })

    const parsed = JSON.parse(result)
    expect(parsed.dependencies).toEqual({
      '@local/helpers': 'workspace:*',
      '@myorg/common': 'workspace:*',
      effect: 'catalog:',
    })
  })

  it('expands peer dependencies from catalog', () => {
    const result = pkg({
      name: '@myorg/utils',
      version: '1.0.0',
      peerDependencies: { react: '^' },
    })

    const parsed = JSON.parse(result)
    expect(parsed.peerDependencies).toEqual({
      react: '^19.2.3',
    })
  })

  it('works without dependencies', () => {
    const result = pkg({
      name: '@myorg/utils',
      version: '1.0.0',
      type: 'module',
    })

    const parsed = JSON.parse(result)
    expect(parsed.name).toBe('@myorg/utils')
    expect(parsed.dependencies).toBeUndefined()
  })

  it('accepts explicit peer dependency versions', () => {
    const result = pkg({
      name: '@myorg/utils',
      version: '1.0.0',
      peerDependencies: {
        effect: '>=3.19.0',
        react: '^',
      },
    })

    const parsed = JSON.parse(result)
    expect(parsed.peerDependencies).toEqual({
      effect: '>=3.19.0',
      react: '^19.2.3',
    })
  })
})
