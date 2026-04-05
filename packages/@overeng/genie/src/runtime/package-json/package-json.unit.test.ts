import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  declarationPathMappingsForPackage,
  packageJson,
  type GenieContext,
  type PackageInfo,
} from '../mod.ts'
import { defineCatalog } from './catalog.ts'

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

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-package-json-'))
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

const workspace = ({ repoName, memberPath }: { repoName: string; memberPath: string }) => ({
  repoName,
  memberPath,
})

const testCatalog = defineCatalog({
  effect: '3.19.14',
  react: '19.2.3',
})

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

    expect(parsed.$genie).toEqual({
      source: 'package.json.genie.ts',
      warning: 'DO NOT EDIT - changes will be overwritten',
    })
    expect(parsed.name).toBe('@test/package')
    expect(parsed.version).toBe('1.0.0')
  })

  it('includes workspaceClosureDirs in $genie when workspace composition is used', () => {
    const repo = createTempRepo('packages/app', 'packages/lib')
    const libComposition = testCatalog.compose({
      workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/lib' }),
    })
    const libPkg = packageJson({ name: '@test/lib', version: '1.0.0' }, libComposition)
    const appComposition = testCatalog.compose({
      workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/app' }),
      dependencies: { workspace: [libPkg] },
    })
    const result = packageJson({ name: '@test/app', version: '1.0.0' }, appComposition)

    const parsed = JSON.parse(result.stringify(mockGenieContext))

    expect(parsed.$genie.workspaceClosureDirs).toEqual(['packages/app', 'packages/lib'])
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

  it('derives declaration path mappings from publishConfig exports', () => {
    expect(
      declarationPathMappingsForPackage({
        packageName: '@test/package',
        packageBasePath: '../repos/test/packages/package',
        exports: {
          '.': './src/mod.ts',
          './effect': './src/effect/mod.ts',
        },
        publishConfigExports: {
          '.': {
            types: './dist/mod.d.ts',
            default: './dist/mod.js',
          },
          './effect': {
            types: './dist/effect/mod.d.ts',
            default: './dist/effect/mod.js',
          },
        },
      }),
    ).toEqual({
      '@test/package': ['../repos/test/packages/package/dist/mod.d.ts'],
      '@test/package/effect': ['../repos/test/packages/package/dist/effect/mod.d.ts'],
    })
  })

  it('falls back to derived dist declarations when publishConfig exports are absent', () => {
    expect(
      declarationPathMappingsForPackage({
        packageName: '@test/package',
        packageBasePath: '../packages/test-package',
        exports: {
          '.': './src/index.ts',
          './node': './src/node/mod.ts',
          './feature': {
            browser: './src/feature/browser.ts',
            default: './src/feature/node.ts',
          },
        },
        publishConfigExports: undefined,
      }),
    ).toEqual({
      '@test/package': ['../packages/test-package/dist/index.d.ts'],
      '@test/package/feature': ['../packages/test-package/dist/feature/node.d.ts'],
      '@test/package/node': ['../packages/test-package/dist/node/mod.d.ts'],
    })
  })

  it('prefers dist/src declarations when that is the emitted layout', () => {
    const repo = createTempRepo('packages/test-package')
    fs.writeFileSync(
      path.join(repo.memberDirs['packages/test-package'], 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { rootDir: '.', outDir: './dist' } }),
    )

    expect(
      declarationPathMappingsForPackage({
        packageName: '@test/package',
        packageBasePath: path.relative(process.cwd(), repo.memberDirs['packages/test-package']),
        exports: {
          '.': './src/index.ts',
        },
        publishConfigExports: undefined,
      }),
    ).toEqual({
      '@test/package': [`${path.relative(process.cwd(), repo.memberDirs['packages/test-package'])}/dist/src/index.d.ts`],
    })
  })

  it('prefers emitted local declarations over publishConfig exports', () => {
    const repo = createTempRepo('packages/test-package')
    fs.writeFileSync(
      path.join(repo.memberDirs['packages/test-package'], 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { rootDir: '.', outDir: './dist' } }),
    )

    expect(
      declarationPathMappingsForPackage({
        packageName: '@test/package',
        packageBasePath: path.relative(process.cwd(), repo.memberDirs['packages/test-package']),
        exports: {
          '.': './src/index.ts',
        },
        publishConfigExports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
      }),
    ).toEqual({
      '@test/package': [`${path.relative(process.cwd(), repo.memberDirs['packages/test-package'])}/dist/src/index.d.ts`],
    })
  })

  it('resolves emitted declarations relative to an explicit workspace root', () => {
    const repo = createTempRepo('packages/test-package')
    fs.writeFileSync(
      path.join(repo.memberDirs['packages/test-package'], 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { rootDir: '.', outDir: './dist' } }),
    )

    expect(
      declarationPathMappingsForPackage({
        packageName: '@test/package',
        packageBasePath: 'packages/test-package',
        workspaceRoot: repo.repoRoot,
        exports: {
          '.': './src/index.ts',
        },
        publishConfigExports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
      }),
    ).toEqual({
      '@test/package': ['packages/test-package/dist/src/index.d.ts'],
    })
  })

  it('preserves non-emitted metadata when provided as the second argument', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
      },
      {
        someMeta: {
          enabled: true,
        },
      },
    )

    expect(result.meta.someMeta).toEqual({
      enabled: true,
    })
    expect(JSON.parse(result.stringify(mockGenieContext))).not.toHaveProperty('meta')
  })

  it('requires workspace metadata when local workspace deps are emitted', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      dependencies: {
        '@test/utils': 'workspace:^',
      },
    })

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '@test/utils',
      message:
        'Package emits local workspace dependency specs but has no workspace metadata. Use packageJson(data, composition) so emitted dependencies and workspace closure stay coupled.',
      rule: 'workspace-metadata-required',
    })
  })

  it('rejects manual dependency buckets when composition is provided', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-composition-'))
    const packageDir = path.join(repo, 'packages', '@test', 'package')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(packageDir, { recursive: true })

    const composition = testCatalog.compose({
      workspace: {
        repoName: path.basename(repo),
        memberPath: 'packages/@test/package',
      },
      dependencies: {
        external: testCatalog.pick('react'),
      },
    })

    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          effect: '^3.18.4',
        },
      } as any,
      composition,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(composition)',
      message:
        'Do not define dependencies/devDependencies/peerDependencies in packageJson(data, composition). Put them into the composition so emitted deps and workspace metadata stay coupled.',
      rule: 'package-json-composition-coupling',
    })
  })

  it('rejects raw workspace metadata', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          '@test/utils': 'workspace:^',
        },
      },
      {
        workspace: {
          repoName: 'workspace',
          memberPath: 'packages/@test/package',
          deps: [],
        },
      } as any,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(workspace metadata)',
      message:
        'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
      rule: 'package-json-workspace-composition-required',
    })
  })

  it('rejects raw workspace metadata even without local workspace specs', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          effect: '^3.18.4',
        },
      },
      {
        workspace: {
          repoName: 'workspace',
          memberPath: 'packages/@test/package',
          deps: [],
        },
      } as any,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(workspace metadata)',
      message:
        'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
      rule: 'package-json-workspace-composition-required',
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

const makeValidationContext = (packages: PackageInfo[]): GenieContext => ({
  location: '.',
  cwd: '/workspace',
  workspace: {
    packages,
    byName: new Map(packages.map((p) => [p.name, p])),
  },
})

describe('packageJson validate hook', () => {
  const validationCatalog = defineCatalog({
    effect: '3.19.14',
  })

  it('returns a validate function', () => {
    const result = packageJson({ name: '@test/pkg', version: '1.0.0' })
    expect(typeof result.validate).toBe('function')
  })

  it('returns no issues when recomposition is correct', () => {
    const repo = createTempRepo('packages/utils', 'packages/app')
    const utilsComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const appComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: [
          packageJson(
            {
              name: '@test/utils',
              version: '1.0.0',
            },
            utilsComposition,
          ),
        ],
      },
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:^' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )

    expect(result.validate!(ctx)).toEqual([])
  })

  it('reports issues when peer deps are missing', () => {
    const repo = createTempRepo('packages/utils', 'packages/app')
    const utilsComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const appComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: [
          packageJson(
            {
              name: '@test/utils',
              version: '1.0.0',
            },
            utilsComposition,
          ),
        ],
      },
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:^' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )

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

describe('packageJson.aggregateFromPackages', () => {
  const repo = createTempRepo('packages/app', 'packages/utils')
  const appComposition = testCatalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/app',
    }),
    dependencies: {
      workspace: [
        packageJson(
          {
            name: '@test/utils',
            version: '1.0.0',
          },
          testCatalog.compose({
            workspace: workspace({
              repoName: repo.repoName,
              memberPath: 'packages/utils',
            }),
          }),
        ),
      ],
    },
  })
  const utilsPkg = appComposition.workspace.deps[0]!
  const appPkg = packageJson(
    {
      name: '@test/app',
      version: '1.0.0',
    },
    appComposition,
  )

  it('returns GenieOutput with projected workspaces and stringify', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    expect(result.data).toEqual({
      name: 'my-monorepo',
      private: true,
      packageManager: 'pnpm@11.0.0-beta.2',
      workspaces: ['packages/app', 'packages/utils'],
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON with $genie marker', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)

    expect(parsed.$genie).toEqual({
      source: 'package.json.genie.ts',
      warning: 'DO NOT EDIT - changes will be overwritten',
    })
    expect(parsed.name).toBe('my-monorepo')
    expect(parsed.private).toBe(true)
    expect(parsed.packageManager).toBe('pnpm@11.0.0-beta.2')
    expect(parsed.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('stops aggregate projection at foreign repo boundaries', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignPkg = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      testCatalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )
    const crossRepoApp = packageJson(
      {
        name: '@test/cross-repo-app',
        version: '1.0.0',
      },
      testCatalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [utilsPkg, foreignPkg],
        },
      }),
    )

    const result = packageJson.aggregateFromPackages({
      packages: [crossRepoApp, utilsPkg, foreignPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    expect(result.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('includes extraMembers in the projected aggregate', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
      extraMembers: ['examples/*'],
    })

    expect(result.data.workspaces).toEqual(['examples/*', 'packages/app', 'packages/utils'])
  })

  it('deduplicates extraMembers with projected members', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
      extraMembers: ['packages/app', 'examples/*'],
    })

    expect(result.data.workspaces).toEqual(['examples/*', 'packages/app', 'packages/utils'])
  })
})
