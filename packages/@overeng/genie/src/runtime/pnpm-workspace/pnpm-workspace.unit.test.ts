import { describe, expect, it } from 'vitest'

import { packageJson } from '../mod.ts'
import {
  AmbiguousWorkspaceRootError,
  computeRelativePath,
  createMegarepoWorkspaceDepsResolver,
  createWorkspaceDepsResolver,
  InvalidWorkspaceRootOverrideError,
  MissingWorkspaceRootError,
} from './mod.ts'

// =============================================================================
// Helper: create a minimal package.json genie output for testing
// =============================================================================

const makePkg = ({
  name,
  ...rest
}: {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}) =>
  packageJson({
    name,
    version: '0.1.0',
    ...rest,
  })

// =============================================================================
// computeRelativePath
// =============================================================================

describe('computeRelativePath', () => {
  it('computes sibling path', () => {
    expect(computeRelativePath({ from: 'packages/app', to: 'packages/shared' })).toBe('../shared')
  })

  it('computes path across different depths', () => {
    expect(computeRelativePath({ from: 'packages/app', to: 'packages/@local/shared' })).toBe(
      '../@local/shared',
    )
  })

  it('computes path going up multiple levels', () => {
    expect(
      computeRelativePath({
        from: 'packages/@local/deep',
        to: 'repos/effect-utils/packages/@overeng/utils',
      }),
    ).toBe('../../../repos/effect-utils/packages/@overeng/utils')
  })

  it('returns "." for same path', () => {
    expect(computeRelativePath({ from: 'packages/app', to: 'packages/app' })).toBe('.')
  })

  it('handles from "." (repo root)', () => {
    expect(computeRelativePath({ from: '.', to: 'packages/utils' })).toBe('packages/utils')
  })

  it('handles from "" (empty string)', () => {
    expect(computeRelativePath({ from: '', to: 'packages/utils' })).toBe('packages/utils')
  })
})

// =============================================================================
// createWorkspaceDepsResolver
// =============================================================================

describe('createWorkspaceDepsResolver', () => {
  describe('single prefix (flat siblings)', () => {
    const resolveDeps = createWorkspaceDepsResolver({
      prefixes: ['@org/'],
      resolveWorkspacePath: (name) => `../${name.split('/')[1]}`,
    })

    it('resolves direct dependencies', () => {
      const pkg = makePkg({
        name: '@org/app',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const utils = makePkg({ name: '@org/utils' })

      const paths = resolveDeps({ pkg, deps: [utils], location: '.' })
      expect(paths).toEqual(['../utils'])
    })

    it('resolves devDependencies', () => {
      const pkg = makePkg({
        name: '@org/app',
        devDependencies: { '@org/test-utils': 'workspace:*' },
      })
      const testUtils = makePkg({ name: '@org/test-utils' })

      const paths = resolveDeps({ pkg, deps: [testUtils], location: '.' })
      expect(paths).toEqual(['../test-utils'])
    })

    it('resolves peerDependencies', () => {
      const pkg = makePkg({
        name: '@org/ui',
        peerDependencies: { '@org/core': 'workspace:*' },
      })
      const core = makePkg({ name: '@org/core' })

      const paths = resolveDeps({ pkg, deps: [core], location: '.' })
      expect(paths).toEqual(['../core'])
    })

    it('ignores external packages', () => {
      const pkg = makePkg({
        name: '@org/app',
        dependencies: {
          '@org/utils': 'workspace:*',
          effect: '3.0.0',
          react: '19.0.0',
        },
      })
      const utils = makePkg({ name: '@org/utils' })

      const paths = resolveDeps({ pkg, deps: [utils], location: '.' })
      expect(paths).toEqual(['../utils'])
    })

    it('resolves transitive dependencies', () => {
      const app = makePkg({
        name: '@org/app',
        dependencies: { '@org/ui': 'workspace:*' },
      })
      const ui = makePkg({
        name: '@org/ui',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const utils = makePkg({ name: '@org/utils' })

      const paths = resolveDeps({ pkg: app, deps: [ui, utils], location: '.' })
      expect(paths).toEqual(['../ui', '../utils'])
    })

    it('deduplicates paths from diamond dependencies', () => {
      //   app -> ui -> utils
      //   app -> core -> utils
      const app = makePkg({
        name: '@org/app',
        dependencies: {
          '@org/ui': 'workspace:*',
          '@org/core': 'workspace:*',
        },
      })
      const ui = makePkg({
        name: '@org/ui',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const core = makePkg({
        name: '@org/core',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const utils = makePkg({ name: '@org/utils' })

      const paths = resolveDeps({ pkg: app, deps: [ui, core, utils], location: '.' })
      expect(paths).toEqual(['../core', '../ui', '../utils'])
    })

    it('returns sorted paths', () => {
      const pkg = makePkg({
        name: '@org/app',
        dependencies: {
          '@org/zlib': 'workspace:*',
          '@org/alpha': 'workspace:*',
          '@org/middle': 'workspace:*',
        },
      })
      const alpha = makePkg({ name: '@org/alpha' })
      const middle = makePkg({ name: '@org/middle' })
      const zlib = makePkg({ name: '@org/zlib' })

      const paths = resolveDeps({ pkg, deps: [alpha, middle, zlib], location: '.' })
      expect(paths).toEqual(['../alpha', '../middle', '../zlib'])
    })

    it('returns empty array when no internal deps', () => {
      const pkg = makePkg({
        name: '@org/standalone',
        dependencies: { effect: '3.0.0' },
      })

      const paths = resolveDeps({ pkg, deps: [], location: '.' })
      expect(paths).toEqual([])
    })

    it('includes extraPackages', () => {
      const pkg = makePkg({
        name: '@org/app',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const utils = makePkg({ name: '@org/utils' })

      const paths = resolveDeps({
        pkg,
        deps: [utils],
        location: '.',
        extraPackages: ['../examples'],
      })
      expect(paths).toEqual(['../examples', '../utils'])
    })

    it('handles circular dependency graphs without infinite loop', () => {
      //   a -> b -> a (circular)
      const a = makePkg({
        name: '@org/a',
        dependencies: { '@org/b': 'workspace:*' },
      })
      const b = makePkg({
        name: '@org/b',
        dependencies: { '@org/a': 'workspace:*' },
      })

      const paths = resolveDeps({ pkg: a, deps: [b], location: '.' })
      expect(paths).toEqual(['../a', '../b'])
    })
  })

  describe('multiple prefixes (cross-repo)', () => {
    const locations: Record<string, string> = {
      '@overeng/utils': 'repos/effect-utils/packages/@overeng/utils',
      '@local/shared': 'packages/@local/shared',
      '@local/ui': 'packages/@local/ui',
    }

    const resolveDeps = createWorkspaceDepsResolver({
      prefixes: ['@overeng/', '@local/'],
      resolveWorkspacePath: (name, from) => {
        const target = locations[name]
        if (target === undefined) throw new Error(`Unknown: ${name}`)
        return computeRelativePath({ from, to: target })
      },
    })

    it('resolves deps across prefixes', () => {
      const app = makePkg({
        name: '@local/app',
        dependencies: {
          '@local/shared': 'workspace:*',
          '@overeng/utils': 'workspace:*',
        },
      })
      const shared = makePkg({ name: '@local/shared' })
      const utils = makePkg({ name: '@overeng/utils' })

      const paths = resolveDeps({ pkg: app, deps: [shared, utils], location: 'packages/app' })
      expect(paths).toEqual([
        '../../repos/effect-utils/packages/@overeng/utils',
        '../@local/shared',
      ])
    })

    it('uses location for relative path computation', () => {
      const pkg = makePkg({
        name: '@local/deep-pkg',
        dependencies: { '@local/shared': 'workspace:*' },
      })
      const shared = makePkg({ name: '@local/shared' })

      const fromShallow = resolveDeps({
        pkg,
        deps: [shared],
        location: 'packages/app',
      })
      const fromDeep = resolveDeps({
        pkg,
        deps: [shared],
        location: 'packages/@local/ui',
      })

      expect(fromShallow).toEqual(['../@local/shared'])
      expect(fromDeep).toEqual(['../shared'])
    })

    it('resolves transitive cross-prefix deps', () => {
      // app (@local) -> shared (@local) -> utils (@overeng)
      const app = makePkg({
        name: '@local/app',
        dependencies: { '@local/shared': 'workspace:*' },
      })
      const shared = makePkg({
        name: '@local/shared',
        dependencies: { '@overeng/utils': 'workspace:*' },
      })
      const utils = makePkg({ name: '@overeng/utils' })

      const paths = resolveDeps({
        pkg: app,
        deps: [shared, utils],
        location: 'packages/app',
      })
      expect(paths).toEqual([
        '../../repos/effect-utils/packages/@overeng/utils',
        '../@local/shared',
      ])
    })
  })

  describe('edge cases', () => {
    const resolveDeps = createWorkspaceDepsResolver({
      prefixes: ['@org/'],
      resolveWorkspacePath: (name) => `../${name.split('/')[1]}`,
    })

    it('handles package with no name', () => {
      const pkg = makePkg({
        name: '@org/app',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      // Anonymous dep — won't be found in registry but dependency is still resolved
      const anonymous = packageJson({ version: '0.1.0' })

      const paths = resolveDeps({ pkg, deps: [anonymous], location: '.' })
      expect(paths).toEqual(['../utils'])
    })

    it('handles deps not in registry (unresolved transitive)', () => {
      // app depends on @org/utils which depends on @org/core,
      // but @org/core is not in the deps array
      const app = makePkg({
        name: '@org/app',
        dependencies: { '@org/utils': 'workspace:*' },
      })
      const utils = makePkg({
        name: '@org/utils',
        dependencies: { '@org/core': 'workspace:*' },
      })
      // @org/core not provided in deps — still gets a path, just no further traversal

      const paths = resolveDeps({ pkg: app, deps: [utils], location: '.' })
      expect(paths).toEqual(['../core', '../utils'])
    })

    it('collects deps from all provided packages, not just pkg', () => {
      // dep1 has its own internal deps that should be collected
      const app = makePkg({ name: '@org/app' })
      const dep1 = makePkg({
        name: '@org/dep1',
        dependencies: { '@org/shared': 'workspace:*' },
      })
      const shared = makePkg({ name: '@org/shared' })

      const paths = resolveDeps({ pkg: app, deps: [dep1, shared], location: '.' })
      expect(paths).toEqual(['../shared'])
    })
  })
})

// =============================================================================
// createMegarepoWorkspaceDepsResolver
// =============================================================================

describe('createMegarepoWorkspaceDepsResolver', () => {
  it('resolves packages for a single root mapping', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [{ id: 'effect-utils', prefix: '@overeng/', path: '../' }],
    })

    const app = makePkg({
      name: '@overeng/app',
      dependencies: { '@overeng/utils': 'workspace:*' },
    })
    const utils = makePkg({ name: '@overeng/utils' })

    const paths = resolveDeps({ pkg: app, deps: [utils], location: '.' })
    expect(paths).toEqual(['../utils'])
  })

  it('resolves packages across multiple roots and prefixes', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [
        {
          id: 'effect-utils',
          prefix: '@overeng/',
          path: 'repos/effect-utils/packages/@overeng',
        },
        {
          id: 'local',
          prefix: '@local/',
          path: 'packages/@local',
        },
      ],
    })

    const app = makePkg({
      name: '@local/app',
      dependencies: {
        '@local/shared': 'workspace:*',
        '@overeng/utils': 'workspace:*',
      },
    })
    const shared = makePkg({ name: '@local/shared' })
    const utils = makePkg({ name: '@overeng/utils' })

    const paths = resolveDeps({
      pkg: app,
      deps: [shared, utils],
      location: 'packages/@local/app',
    })

    expect(paths).toEqual(['../../../repos/effect-utils/packages/@overeng/utils', '../shared'])
  })

  it('throws MissingWorkspaceRootError for unknown internal prefix', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [{ id: 'effect-utils', prefix: '@overeng/', path: 'packages/@overeng' }],
      internalPrefixes: ['@overeng/', '@local/'],
    })

    const app = makePkg({
      name: '@overeng/app',
      dependencies: { '@local/shared': 'workspace:*' },
    })

    expect(() => resolveDeps({ pkg: app, deps: [], location: '.' })).toThrow(
      MissingWorkspaceRootError,
    )
  })

  it('throws AmbiguousWorkspaceRootError for same-prefix multi-root without override', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [
        {
          id: 'effect-utils',
          prefix: '@overeng/',
          path: 'repos/effect-utils/packages/@overeng',
        },
        {
          id: 'private-shared',
          prefix: '@overeng/',
          path: 'repos/private-shared/packages/@overeng',
        },
      ],
    })

    const app = makePkg({
      name: '@overeng/app',
      dependencies: { '@overeng/geist-design-system': 'workspace:*' },
    })

    expect(() => resolveDeps({ pkg: app, deps: [], location: '.' })).toThrow(
      AmbiguousWorkspaceRootError,
    )
  })

  it('uses packageRootOverrides for same-prefix multi-root packages', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [
        {
          id: 'effect-utils',
          prefix: '@overeng/',
          path: 'repos/effect-utils/packages/@overeng',
        },
        {
          id: 'private-shared',
          prefix: '@overeng/',
          path: 'repos/private-shared/packages/@overeng',
        },
      ],
      packageRootOverrides: {
        '@overeng/geist-design-system': 'private-shared',
      },
    })

    const app = makePkg({
      name: '@overeng/app',
      dependencies: { '@overeng/geist-design-system': 'workspace:*' },
    })

    const paths = resolveDeps({ pkg: app, deps: [], location: '.' })
    expect(paths).toEqual(['repos/private-shared/packages/@overeng/geist-design-system'])
  })

  it('throws InvalidWorkspaceRootOverrideError for invalid override root id', () => {
    const resolveDeps = createMegarepoWorkspaceDepsResolver({
      roots: [
        {
          id: 'effect-utils',
          prefix: '@overeng/',
          path: 'repos/effect-utils/packages/@overeng',
        },
        {
          id: 'private-shared',
          prefix: '@overeng/',
          path: 'repos/private-shared/packages/@overeng',
        },
      ],
      packageRootOverrides: {
        '@overeng/geist-design-system': 'missing-root',
      },
    })

    const app = makePkg({
      name: '@overeng/app',
      dependencies: { '@overeng/geist-design-system': 'workspace:*' },
    })

    expect(() => resolveDeps({ pkg: app, deps: [], location: '.' })).toThrow(
      InvalidWorkspaceRootOverrideError,
    )
  })
})
