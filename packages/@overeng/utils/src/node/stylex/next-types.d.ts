/** Options for {@link createStylexNext}. */
export interface StylexNextOptions {
  /**
   * Absolute path of the Next.js app root: the directory that owns
   * `next.config.mjs`, `postcss.config.mjs`, and the carrier stylesheet.
   */
  readonly rootDir: string
  /**
   * Dirs relative to `rootDir` whose source is StyleX-compiled. Scoped into
   * both the webpack rule (as resolved absolute paths) and the PostCSS
   * plugin's `include` globs, so the transform and the collector always cover
   * the same source.
   */
  readonly sourceDirs: readonly string[]
  /**
   * Stylesheet relative to `rootDir` whose `@stylex;` at-rule the PostCSS
   * plugin replaces with the compiled stylesheet. The root layout must import
   * it; the adapter fails the build loudly when that import goes missing.
   */
  readonly cssCarrier: string
  /**
   * Packages under the app's `node_modules` that ship uncompiled StyleX
   * source and must be compiled by us. Token-only packages whose exports are
   * consumed through import following do not need to be listed.
   */
  readonly externalPackages?: readonly string[]
  /**
   * File extensions the collector scans. Defaults to
   * `['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']` — every extension the webpack
   * rule's test matches, so collection is a superset of transformation by
   * construction. `mdx` is rejected: the PostCSS plugin cannot parse it.
   */
  readonly extensions?: readonly string[]
  /**
   * Emit compiled rules into cascade layers. Defaults to OFF, and that default
   * is load-bearing rather than conservative: unlayered StyleX beats a utility
   * framework's layered utilities unconditionally, which is what lets
   * converted code win during a migration without any ordering work.
   */
  readonly useCSSLayers?: boolean
  /**
   * StyleX dev mode. Defaults to `NODE_ENV === 'development'`. Shared by both
   * the webpack transform and the PostCSS collector, so class names cannot
   * drift between the JS and the CSS.
   */
  readonly dev?: boolean
}

/**
 * A webpack rule as Next.js receives it, described structurally. Naming
 * webpack's own types here would publish this package's bundler major as part
 * of the contract, exactly like the Vite entry's `StylexVitePlugin`.
 */
export interface StylexWebpackRule {
  test: RegExp
  include: readonly string[]
  enforce: 'pre'
  use: readonly { loader: string; options: unknown }[]
}

/** The slice of `next.config.js` the adapter's `webpack` hook touches. */
export interface StylexNextWebpackConfig {
  module?: { rules?: unknown[] }
  plugins?: unknown[]
  [key: string]: unknown
}

/** The slice of Next's second webpack-hook argument the adapter reads. */
export interface StylexNextWebpackHookOptions {
  isServer?: boolean
  nextRuntime?: string
  [key: string]: unknown
}

/** Options handed to `@stylexjs/postcss-plugin`. */
export interface StylexPostcssPluginOptions {
  cwd: string
  include: readonly string[]
  babelConfig: unknown
  useCSSLayers: boolean
}

/**
 * Shared StyleX Next.js integration. Create one instance in a module both
 * `next.config.mjs` and `postcss.config.mjs` import, so the Babel options
 * feeding the webpack transform and the PostCSS collector are one object, not
 * two copies.
 */
export interface StylexNextAdapter {
  /** Value for the Next.js `webpack` config key. */
  readonly webpack: (
    config: StylexNextWebpackConfig,
    nextOptions?: StylexNextWebpackHookOptions,
  ) => StylexNextWebpackConfig
  /** The `enforce: 'pre'` babel-loader rule the hook pushes. */
  readonly webpackRule: StylexWebpackRule
  /** Entry to spread into `postcss.config`'s `plugins`. */
  readonly postcssPlugin: { '@stylexjs/postcss-plugin': StylexPostcssPluginOptions }
}

/** Shared StyleX integration for a webpack-built Next.js app. */
export declare const createStylexNext: (options: StylexNextOptions) => StylexNextAdapter
