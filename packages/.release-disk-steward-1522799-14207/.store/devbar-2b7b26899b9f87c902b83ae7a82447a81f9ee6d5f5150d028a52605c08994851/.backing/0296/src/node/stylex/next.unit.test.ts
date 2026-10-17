import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { StylexNextAdapter, StylexNextOptions } from './next-types.d.ts'
import { createStylexNext } from './next.js'

const makeAppRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'overeng-stylex-next-unit-'))
  mkdirSync(join(root, 'src', 'styles'), { recursive: true })
  writeFileSync(join(root, 'src', 'styles', 'globals.css'), '@stylex;\n')
  return root
}

const makeOptions = (root: string): StylexNextOptions => ({
  rootDir: root,
  sourceDirs: ['src'],
  cssCarrier: 'src/styles/globals.css',
})

/** Runs the body against a throwaway app root that is removed afterwards. */
const withAppRoot = (fn: (root: string, options: StylexNextOptions) => void) => {
  const root = makeAppRoot()
  try {
    fn(root, makeOptions(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('createStylexNext config-time guards', () => {
  it('rejects a rootDir that is not absolute', () => {
    expect(() =>
      createStylexNext({ rootDir: 'apps/web', sourceDirs: ['src'], cssCarrier: 'g.css' }),
    ).toThrowError(/rootDir.*absolute/u)
  })

  it('rejects a missing carrier stylesheet', () => {
    withAppRoot((root, options) => {
      rmSync(join(root, 'src', 'styles', 'globals.css'))
      expect(() => createStylexNext(options)).toThrowError(
        /cssCarrier src\/styles\/globals\.css does not exist/u,
      )
    })
  })

  it('rejects a carrier whose @stylex at-rule was removed', () => {
    withAppRoot((root, options) => {
      writeFileSync(join(root, 'src', 'styles', 'globals.css'), 'body { margin: 0 }\n')
      expect(() => createStylexNext(options)).toThrowError(/no `@stylex;` at-rule/u)
    })
  })
  it('rejects a carrier whose apparent at-rule is inside a comment or another rule', () => {
    withAppRoot((root, options) => {
      for (const css of [
        '/* @stylex; */',
        '.example { content: "@stylex;" }',
        '@stylex something;',
      ]) {
        writeFileSync(join(root, 'src', 'styles', 'globals.css'), css)
        expect(() => createStylexNext(options), css).toThrowError(/no `@stylex;` at-rule/u)
      }
    })
  })

  it('rejects a sourceDir that does not exist', () => {
    withAppRoot((_root, options) => {
      expect(() => createStylexNext({ ...options, sourceDirs: ['src', 'lib'] })).toThrowError(
        /sourceDir lib does not exist/u,
      )
    })
  })

  it('rejects mdx in extensions because the collector cannot parse it', () => {
    withAppRoot((_root, options) => {
      expect(() => createStylexNext({ ...options, extensions: ['ts', 'tsx', 'mdx'] })).toThrowError(
        /must not include mdx/u,
      )
    })
  })
  it('rejects extensions the StyleX Babel collector cannot parse or an empty set', () => {
    withAppRoot((_root, options) => {
      expect(() => createStylexNext({ ...options, extensions: [] })).toThrowError(/extensions/u)
      expect(() => createStylexNext({ ...options, extensions: ['ts', 'css'] })).toThrowError(
        /extension.*css/u,
      )
    })
  })
})

describe('createStylexNext config builders', () => {
  it('builds an enforce-pre babel-loader rule scoped to resolved source dirs', () => {
    withAppRoot((root, options) => {
      const rule = createStylexNext(options).webpackRule

      expect({
        enforce: rule.enforce,
        loader: rule.use[0]?.loader,
        include: rule.include,
        matchesTsx: rule.test.test('/app/src/card.tsx'),
        matchesMts: rule.test.test('/app/src/lib.mts'),
        matchesMdx: rule.test.test('/app/src/post.mdx'),
      }).toEqual({
        enforce: 'pre',
        loader: 'babel-loader',
        include: [join(root, 'src')],
        matchesTsx: true,
        matchesMts: true,
        matchesMdx: false,
      })
    })
  })

  it('shares one babel options object between the webpack rule and the postcss entry', () => {
    withAppRoot((_root, options) => {
      const adapter = createStylexNext(options)
      const webpackOptions = adapter.webpackRule.use[0]?.options
      const postcssBabelConfig = adapter.postcssPlugin['@stylexjs/postcss-plugin'].babelConfig

      // Identity, not deep equality: the transform that rewrites the JS and
      // the one that collects the CSS must read the same object, so no later
      // edit to either side can drift them apart.
      expect(webpackOptions).toBe(postcssBabelConfig)
    })
  })

  it('keeps babel confined to stylex and syntax parsing', () => {
    withAppRoot((root, options) => {
      const adapter = createStylexNext({ ...options, dev: false })
      const optionsValue = adapter.webpackRule.use[0]?.options as Record<string, unknown>

      expect({
        babelrc: optionsValue.babelrc,
        configFile: optionsValue.configFile,
        cwd: optionsValue.cwd,
        parserPlugins: (optionsValue.parserOpts as { plugins: string[] }).plugins,
        plugins: optionsValue.plugins,
      }).toEqual({
        babelrc: false,
        configFile: false,
        cwd: root,
        parserPlugins: ['typescript', 'jsx'],
        plugins: [
          [
            '@stylexjs/babel-plugin',
            {
              dev: false,
              // The PostCSS plugin owns CSS emission; runtime injection would
              // duplicate every rule and bypass the global priority sort.
              runtimeInjection: false,
              enableInlinedConditionalMerge: true,
              treeshakeCompensation: true,
              unstable_moduleResolution: { type: 'commonJS' },
            },
          ],
        ],
      })
    })
  })

  it('collects every transformed extension, including mts and cts, from app and custom roots', () => {
    withAppRoot((root, options) => {
      mkdirSync(join(root, 'lib'), { recursive: true })
      const adapter = createStylexNext({ ...options, sourceDirs: ['src', 'lib'] })
      expect(adapter.postcssPlugin['@stylexjs/postcss-plugin'].include).toEqual([
        'src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
        'lib/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
      ])
      for (const extension of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']) {
        expect(adapter.webpackRule.test.test(`/app/src/file.${extension}`), extension).toBe(true)
      }
      const custom = createStylexNext({ ...options, extensions: ['tsx', 'mts'] })
      expect(custom.webpackRule.test.test('/app/src/card.tsx')).toBe(true)
      expect(custom.webpackRule.test.test('/app/src/vars.mts')).toBe(true)
      expect(custom.webpackRule.test.test('/app/src/old.js')).toBe(false)
      expect(custom.postcssPlugin['@stylexjs/postcss-plugin'].include).toEqual([
        'src/**/*.{tsx,mts}',
      ])
    })
  })

  it('requires externalPackages in Next transpilePackages while collecting and transforming them', () => {
    withAppRoot((root, options) => {
      const packageDir = join(root, 'node_modules', '@scope', 'pkg')
      mkdirSync(packageDir, { recursive: true })
      const adapter = createStylexNext({ ...options, externalPackages: ['@scope/pkg'] })

      expect(adapter.transpilePackages).toEqual(['@scope/pkg'])
      expect(adapter.webpackRule.include).toEqual([join(root, 'src'), packageDir])
      expect(adapter.postcssPlugin['@stylexjs/postcss-plugin'].include).toContain(
        'node_modules/@scope/pkg/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
      )
      expect(() => adapter.webpack({ module: { rules: [] } }, { isServer: true })).toThrowError(
        /transpilePackages.*@scope\/pkg/u,
      )
      expect(() =>
        adapter.webpack(
          { module: { rules: [] } },
          { isServer: true, config: { transpilePackages: ['other'] } },
        ),
      ).toThrowError(/transpilePackages.*@scope\/pkg/u)
      expect(
        adapter.webpack(
          { module: { rules: [] } },
          {
            isServer: true,
            config: { transpilePackages: ['other', ...adapter.transpilePackages] },
          },
        ).module?.rules,
      ).toHaveLength(1)
    })
  })
})

describe('createStylexNext webpack hook', () => {
  it('pushes the rule into every compilation and the guard into the client one only', () => {
    withAppRoot((_root, options) => {
      const adapter = createStylexNext(options)
      const client = adapter.webpack({ module: { rules: [] }, plugins: [] }, { isServer: false })
      const server = adapter.webpack({ module: { rules: [] }, plugins: [] }, { isServer: true })
      const edge = adapter.webpack(
        { module: { rules: [] }, plugins: [] },
        { isServer: false, nextRuntime: 'edge' },
      )

      expect({
        clientRules: client.module?.rules?.length,
        serverRules: server.module?.rules?.length,
        edgeRules: edge.module?.rules?.length,
        clientGuard: (client.plugins as { name?: string }[]).map((plugin) => plugin.name),
        serverGuard: (server.plugins as { name?: string }[]).map((plugin) => plugin.name),
        edgeGuard: (edge.plugins as { name?: string }[]).map((plugin) => plugin.name),
      }).toEqual({
        clientRules: 1,
        serverRules: 1,
        edgeRules: 1,
        clientGuard: ['overeng:stylex/next-css-guard'],
        serverGuard: [],
        edgeGuard: [],
      })
    })
  })
})

describe('createStylexNext build-time guard', () => {
  /**
   * Minimal fakes of the webpack hook surface the guard taps. The guard is
   * deliberately structural, so these stand in for webpack without importing
   * it — the fixture build proves the same taps against real webpack.
   */
  const runGuard = ({
    carrierInGraph,
    cssAssets,
    dev,
  }: {
    carrierInGraph: boolean
    cssAssets: Record<string, string>
    dev: boolean
  }): unknown[] => {
    const errors: unknown[] = []
    let guard: { name?: string; apply?: (compiler: unknown) => void } | undefined
    withAppRoot((root, options) => {
      const config = createStylexNext({ ...options, dev }).webpack(
        { module: { rules: [] }, plugins: [] },
        { isServer: false, dev },
      )
      guard = (config.plugins as { name?: string; apply?: (compiler: unknown) => void }[]).find(
        (plugin) => plugin.name === 'overeng:stylex/next-css-guard',
      )
      const compilation = {
        hooks: {
          finishModules: { tap: (_name: string, fn: () => void) => fn() },
          processAssets: { tap: (_name: string, fn: () => void) => fn() },
        },
        modules:
          carrierInGraph === true
            ? [{ resource: join(root, 'src', 'styles', 'globals.css') }]
            : [{ resource: join(root, 'src', 'app', 'page.tsx') }],
        errors,
        getAssets: () =>
          Object.entries(cssAssets).map(([name, source]) => ({
            name,
            source: { source: () => source },
          })),
      }
      guard?.apply?.({
        hooks: {
          compilation: { tap: (_name: string, fn: (value: unknown) => void) => fn(compilation) },
        },
      })
    })
    return errors
  }

  it('fails the build when css residue survives into an emitted asset', () => {
    const errors = runGuard({
      carrierInGraph: true,
      dev: false,
      cssAssets: { 'static/css/chunk.css': '.x1{color:red}@stylex;' },
    })

    expect(errors).toHaveLength(1)
    expect(String((errors[0] as Error).message)).toMatch(
      /still contains an unreplaced `@stylex` at-rule/u,
    )
  })
  it('ignores @stylex text in comments and declarations but detects real at-rules', () => {
    const ordinary = runGuard({
      carrierInGraph: true,
      dev: false,
      cssAssets: { 'static/css/chunk.css': '/* @stylex; */ .x { content: "@stylex;" }' },
    })
    const nested = runGuard({
      carrierInGraph: true,
      dev: false,
      cssAssets: { 'static/css/chunk.css': '@media screen { @stylex; }' },
    })
    expect(ordinary).toEqual([])
    expect(nested).toHaveLength(1)
  })

  it('fails the build when the carrier is not in the client module graph', () => {
    const errors = runGuard({ carrierInGraph: false, dev: false, cssAssets: {} })

    expect(errors).toHaveLength(1)
    expect(String((errors[0] as Error).message)).toMatch(
      /not part of the client build's module graph/u,
    )
  })

  it('stays silent on a healthy client compilation', () => {
    const errors = runGuard({
      carrierInGraph: true,
      dev: false,
      cssAssets: { 'static/css/chunk.css': '.x1{color:red}' },
    })

    expect(errors).toEqual([])
  })

  it('skips the module-graph check but keeps the residue check in dev', () => {
    const missingCarrier = runGuard({ carrierInGraph: false, dev: true, cssAssets: {} })
    const residue = runGuard({
      carrierInGraph: true,
      dev: true,
      cssAssets: { 'static/css/chunk.css': '@stylex;' },
    })

    expect({ missingCarrier, residueLength: residue.length }).toEqual({
      missingCarrier: [],
      residueLength: 1,
    })
  })
})

describe('createStylexNext published surface', () => {
  it('never names a bundler type in the published signature', () => {
    // Same rationale as the Vite entry: a nominal Next/webpack type in the
    // declaration would publish this package's bundler major as part of its
    // contract. Reading the source keeps the guard honest — a type-level
    // assertion silently degrades to `any` if the declaration fails to
    // resolve.
    const declaration = readFileSync(new URL('./next-types.d.ts', import.meta.url), 'utf8')
    const implementation = readFileSync(new URL('./next.js', import.meta.url), 'utf8')

    expect({
      declarationImportsBundler: /from '(next|webpack)'/.test(declaration) === true,
      implementationNamesBundlerType: /@import .*'(next|webpack)'/u.test(implementation) === true,
    }).toEqual({ declarationImportsBundler: false, implementationNamesBundlerType: false })
  })

  it('publishes the transpilePackages value required by the webpack hook', () => {
    const publishedSurface: (keyof StylexNextAdapter)[] = [
      'webpack',
      'webpackRule',
      'postcssPlugin',
      'transpilePackages',
    ]
    expect(publishedSurface).toEqual([
      'webpack',
      'webpackRule',
      'postcssPlugin',
      'transpilePackages',
    ])
  })

  it('resolves the module through the package export map', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> }

    expect(Object.keys(packageJson.exports)).toContain('./node/stylex/next')
  })
})
