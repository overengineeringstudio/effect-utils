// The Next.js counterpart of `createStylexVitePlugins` (./mod.js): compiled
// StyleX CSS for a webpack-built Next.js app.
//
// Why Babel, and why not the obvious places:
//
// - `@stylexjs/nextjs-plugin` is npm-deprecated and frozen at StyleX 0.11.1.
// - `@stylexjs/unplugin` publishes no `./next` entry, and its CSS emission is
//   written against Rollup's `emitFile`/`getFileName`, which webpack does not
//   provide.
// - There is no SWC plugin on npm, so the transform has to be Babel.
//
// It is deliberately NOT a `babel.config.js`. Next detects a root Babel config
// and switches the whole app off SWC, which breaks `next/font` outright (the
// build fails). Registering the same plugin as a webpack `enforce: 'pre'`
// babel-loader rule scoped to the configured source dirs keeps SWC as the app
// compiler and confines Babel to stripping `stylex.*` calls out of app source.
//
// Emission is PostCSS-owned: `@stylexjs/postcss-plugin` scans the same source
// dirs, transforms each file with the same Babel options, and replaces the
// `@stylex;` at-rule in the carrier stylesheet with one globally sorted and
// de-duplicated stylesheet. One emission point is what makes atomic priority
// ordering correct. The Babel options object is shared *by identity* between
// the webpack rule and the PostCSS entry, so the transform that rewrites the
// JS and the one that collects the CSS can never drift — the class names in
// server-rendered markup and the selectors in the emitted CSS are produced by
// the same options.
//
// Scope: Next.js 15.5 and 16, webpack mode. On Next 16 Turbopack is the
// default for both `dev` and `build`, so pass `--webpack` there; Turbopack is
// unsupported until proven — it never calls the webpack hook, so `stylex.*`
// calls stay uncompiled and styling silently degrades to the runtime.
//
// The consuming app must install `babel-loader`, `@stylexjs/babel-plugin`, and
// `@stylexjs/postcss-plugin`: all three are referenced by name so they resolve
// from the app, not from this package.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { parse } from 'postcss'

/**
 * @import {
 *   StylexNextAdapter,
 *   StylexNextOptions,
 *   StylexNextWebpackConfig,
 *   StylexNextWebpackHookOptions,
 *   StylexWebpackRule,
 * } from './next-types.d.ts'
 */

const STYLEX_BABEL_PLUGIN = '@stylexjs/babel-plugin'
const STYLEX_POSTCSS_PLUGIN = '@stylexjs/postcss-plugin'
const GUARD_NAME = 'overeng:stylex/next-css-guard'

/**
 * Babel-parser-compatible suffixes. One validated set drives the webpack
 * test and collector globs; `.mdx` needs its own parser and is excluded.
 */
const DEFAULT_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']
const SUPPORTED_EXTENSIONS = new Set(DEFAULT_EXTENSIONS)

/** @param {string} css */
const hasStylexAtRule = (css) => {
  let found = false
  parse(css).walkAtRules('stylex', () => {
    found = true
  })
  return found
}

/** @param {string} css */
const hasEmptyStylexAtRule = (css) => {
  let found = false
  parse(css).walkAtRules('stylex', (rule) => {
    if (rule.nodes === undefined && rule.params.trim() === '') found = true
  })
  return found
}

/**
 * @param {string} path
 * @returns {string}
 */
const toPosix = (path) => path.split(sep).join('/')

/**
 * A webpack compilation, described by the hooks and members the guard uses.
 * Deliberately structural — naming webpack's own types here would publish this
 * package's bundler major as part of the contract, exactly like the Vite entry.
 *
 * @typedef {object} WebpackCompilerLike
 * @property {{ compilation: { tap: (name: string, fn: (compilation: unknown) => void) => void } }} hooks
 *
 * @typedef {object} WebpackCompilationLike
 * @property {{ finishModules: { tap: (name: string, fn: () => void) => void }, processAssets: { tap: (name: string, fn: () => void) => void } }} hooks
 * @property {Iterable<{ resource?: unknown }>} modules
 * @property {unknown[]} errors
 * @property {() => Array<{ name: string, source: { source: () => string | Buffer } }>} getAssets
 */

/**
 * Webpack plugin that turns the two silent loss modes of the PostCSS-owned
 * emission path into build failures on the client compilation:
 *
 * - the carrier stylesheet is not in the module graph — nothing imports it,
 *   typically because the root layout lost its `import './globals.css'` — so
 *   the compiled rules exist nowhere the bundle can reach; and
 * - a `@stylex` at-rule survived into an emitted CSS asset, meaning the
 *   PostCSS plugin never replaced it and every rule it should have carried
 *   was dropped.
 *
 * @param {{ carrierPath: string, cssCarrier: string, dev: boolean }} settings
 * @returns {{ name: string, apply: (compiler: unknown) => void }}
 */
const createCarrierGuard = ({ carrierPath, cssCarrier, dev }) => ({
  name: GUARD_NAME,
  apply(compiler) {
    ;/** @type {WebpackCompilerLike} */ (compiler).hooks.compilation.tap(
      GUARD_NAME,
      (compilationValue) => {
        const compilation = /** @type {WebpackCompilationLike} */ (compilationValue)
        // Dev keeps lazy/HMR module graphs that can legitimately defer the
        // carrier import until a route is first visited, so the module-graph
        // check is build-only. The residue check below stays in both modes.
        if (dev !== true) {
          compilation.hooks.finishModules.tap(GUARD_NAME, () => {
            let carrierSeen = false
            for (const module of compilation.modules) {
              if (module?.resource === carrierPath) {
                carrierSeen = true
                break
              }
            }
            if (carrierSeen === false) {
              compilation.errors.push(
                new Error(
                  `[overeng:stylex/next] ${cssCarrier} is not part of the client build's module graph, so compiled StyleX CSS cannot reach the bundle. Import the carrier stylesheet from the root layout.`,
                ),
              )
            }
          })
        }
        compilation.hooks.processAssets.tap(GUARD_NAME, () => {
          for (const asset of compilation.getAssets()) {
            if (asset.name.endsWith('.css') !== true) continue
            const css = String(asset.source.source())
            if (hasStylexAtRule(css) === true) {
              compilation.errors.push(
                new Error(
                  `[overeng:stylex/next] CSS asset ${asset.name} still contains an unreplaced \`@stylex\` at-rule, so the PostCSS plugin never collected into ${cssCarrier} and every compiled rule was dropped. Check that postcss.config loads ${STYLEX_POSTCSS_PLUGIN} and shares this adapter's instance.`,
                ),
              )
            }
          }
        })
      },
    )
  },
})

/**
 * Whether a webpack config-hook invocation is the client compilation that owns
 * emitted CSS. Server compilations drop CSS imports; edge runtimes have their
 * own graphs, so a proven-unsupported edge app fails loudly instead of
 * silently shipping without StyleX CSS.
 *
 * @param {{ isServer?: boolean, nextRuntime?: string } | undefined} nextOptions
 * @returns {boolean}
 */
const isClientCompilation = (nextOptions) =>
  nextOptions?.isServer !== true && (nextOptions?.nextRuntime ?? 'node') === 'node'

/**
 * Shared StyleX integration for a webpack-built Next.js app. Create one
 * instance in a module both `next.config.mjs` and `postcss.config.mjs` import,
 * so the Babel options feeding the two passes are one object, not two copies:
 *
 *     // stylex.mjs
 *     import { fileURLToPath } from 'node:url'
 *
 *     export const stylex = createStylexNext({
 *       rootDir: fileURLToPath(new URL('.', import.meta.url)),
 *       sourceDirs: ['src'],
 *       cssCarrier: 'src/styles/globals.css',
 *     })
 *     // next.config.mjs
 *     export default { transpilePackages: stylex.transpilePackages, webpack: stylex.webpack }
 *     // postcss.config.mjs
 *     export default { plugins: { ...stylex.postcssPlugin } }
 *
 * @param {StylexNextOptions} options
 * @returns {StylexNextAdapter}
 */
export const createStylexNext = (options) => {
  const rootDir = options?.rootDir
  if (typeof rootDir !== 'string' || isAbsolute(rootDir) === false) {
    throw new Error(
      '[overeng:stylex/next] `rootDir` is required and must be an absolute path: the Next.js app root that owns next.config, postcss.config, and the carrier stylesheet.',
    )
  }

  const sourceDirs = options?.sourceDirs
  if (Array.isArray(sourceDirs) !== true || sourceDirs.length === 0) {
    throw new Error(
      '[overeng:stylex/next] `sourceDirs` is required: the dirs (relative to rootDir) whose source is StyleX-compiled.',
    )
  }

  const cssCarrier = options?.cssCarrier
  if (typeof cssCarrier !== 'string' || cssCarrier === '') {
    throw new Error(
      '[overeng:stylex/next] `cssCarrier` is required: the stylesheet (relative to rootDir) whose `@stylex;` at-rule receives the compiled rules.',
    )
  }

  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS
  if (Array.isArray(extensions) !== true || extensions.length === 0) {
    throw new Error('[overeng:stylex/next] `extensions` must be a non-empty array.')
  }
  for (const extension of extensions) {
    if (extension === 'mdx') {
      throw new Error(
        '[overeng:stylex/next] `extensions` must not include mdx: the PostCSS plugin Babel-parses every matched file and cannot parse MDX.',
      )
    }
    if (SUPPORTED_EXTENSIONS.has(extension) === false) {
      throw new Error(
        `[overeng:stylex/next] extension ${JSON.stringify(extension)} is not a supported JavaScript/TypeScript suffix.`,
      )
    }
  }
  const selectedExtensions = [...new Set(extensions)]

  // Loud config-time checks for the two ways the emission path dies silently.
  // Both are checked again at build time by the guard on the client
  // compilation; checking here catches a broken carrier before any compile.
  const carrierPath = resolve(rootDir, cssCarrier)
  if (existsSync(carrierPath) === false) {
    throw new Error(
      `[overeng:stylex/next] cssCarrier ${cssCarrier} does not exist (resolved ${carrierPath}). The PostCSS plugin writes compiled StyleX rules there and the root layout must import it.`,
    )
  }
  if (hasEmptyStylexAtRule(readFileSync(carrierPath, 'utf8')) === false) {
    throw new Error(
      `[overeng:stylex/next] cssCarrier ${cssCarrier} has no \`@stylex;\` at-rule. Without it the PostCSS plugin has nowhere to write and the app silently ships with no StyleX CSS.`,
    )
  }

  const sourceRoots = sourceDirs.map((dir) => {
    if (typeof dir !== 'string' || dir === '' || isAbsolute(dir) === true) {
      throw new Error(
        `[overeng:stylex/next] sourceDirs entries must be non-empty paths relative to rootDir, got ${JSON.stringify(dir)}.`,
      )
    }
    const absolute = resolve(rootDir, dir)
    if (existsSync(absolute) === false) {
      throw new Error(
        `[overeng:stylex/next] sourceDir ${dir} does not exist (resolved ${absolute}); an include that matches nothing collects nothing.`,
      )
    }
    return { dir, absolute }
  })

  const externalPackages = [...new Set(options?.externalPackages ?? [])]
  const externalRoots = externalPackages.map((name) => {
    // Resolved through the app's node_modules and realpathed: webpack's
    // `resolve.symlinks` default records module resources as real paths, so a
    // symlinked package dir would silently never match the rule.
    const linked = join(rootDir, 'node_modules', ...name.split('/'))
    if (existsSync(linked) === false) {
      throw new Error(
        `[overeng:stylex/next] externalPackage ${name} is not installed under ${rootDir}.`,
      )
    }
    return realpathSync(linked)
  })

  const dev = options?.dev ?? process.env.NODE_ENV === 'development'

  /**
   * The one StyleX options object. Both the webpack rule and the PostCSS entry
   * close over this exact object; `dev` is computed once so the class names
   * Babel writes into the JS and the selectors it collects for the CSS are
   * generated under the same flag.
   */
  const stylexBabelOptions = {
    babelrc: false,
    configFile: false,
    cwd: rootDir,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    plugins: [
      [
        STYLEX_BABEL_PLUGIN,
        {
          dev,
          // The PostCSS plugin owns CSS emission. Runtime injection would
          // duplicate every rule and bypass the global priority sort.
          runtimeInjection: false,
          // Matches @stylexjs/unplugin's Vite path: with it, the atomic
          // class names this transform writes into the JS are identical to
          // the ones the Vite/Babel path produces for the same source — the
          // fixture build test asserts that equality.
          enableInlinedConditionalMerge: true,
          treeshakeCompensation: true,
          unstable_moduleResolution: { type: 'commonJS' },
        },
      ],
    ],
  }

  const extensionGlob = `**/*.{${selectedExtensions.join(',')}}`
  const includeGlobs = [
    ...sourceRoots.map(({ dir }) => `${toPosix(dir)}/${extensionGlob}`),
    ...externalPackages.map((name) => `node_modules/${name}/${extensionGlob}`),
  ]

  /** @type {StylexWebpackRule} */
  const webpackRule = {
    test: new RegExp(`\\.(${selectedExtensions.join('|')})$`, 'u'),
    include: [...sourceRoots.map(({ absolute }) => absolute), ...externalRoots],
    enforce: 'pre',
    use: [{ loader: 'babel-loader', options: stylexBabelOptions }],
  }

  const guard = createCarrierGuard({ carrierPath, cssCarrier, dev })

  /**
   * Next.js `webpack` config-hook value: pushes the Babel pre-loader rule
   * into every compilation — server code renders the same class names — and
   * adds the CSS guard to the client compilation that owns emitted CSS.
   *
   * @param {StylexNextWebpackConfig} config
   * @param {StylexNextWebpackHookOptions} [nextOptions]
   * @returns {StylexNextWebpackConfig}
   */
  // oxlint-disable-next-line overeng/named-args -- Next passes a fixed positional (config, options) pair.
  const webpack = (config, nextOptions) => {
    const configuredPackages = nextOptions?.config?.transpilePackages
    const missingPackages = externalPackages.filter(
      (name) => configuredPackages?.includes(name) !== true,
    )
    if (missingPackages.length > 0) {
      throw new Error(
        `[overeng:stylex/next] Next config transpilePackages must include ${missingPackages.join(', ')} from externalPackages. Spread stylex.transpilePackages into next.config to compile their TS/JSX.`,
      )
    }
    config.module ??= { rules: [] }
    config.module.rules ??= []
    config.module.rules.push(webpackRule)
    if (isClientCompilation(nextOptions) === true) {
      config.plugins ??= []
      config.plugins.push(guard)
    }
    return config
  }

  const postcssPlugin = {
    [STYLEX_POSTCSS_PLUGIN]: {
      cwd: rootDir,
      include: includeGlobs,
      babelConfig: stylexBabelOptions,
      useCSSLayers: options?.useCSSLayers ?? false,
    },
  }

  return { webpack, webpackRule, postcssPlugin, transpilePackages: externalPackages }
}
