import type { Plugin } from 'vite'

/**
 * Module specifier of the virtual stylesheet holding all compiled StyleX rules.
 *
 * Every build entry must import this exactly once. That single static import is
 * the whole eager-placement guarantee: the bundler then owns which asset the
 * rules land in, how it is hashed, whether it is minified, and whether it shows
 * up in the manifest.
 */
export declare const stylexVirtualCssId: 'virtual:overeng-stylex.css'

/** Options for {@link createStylexVitePlugins}. */
export interface StylexVitePluginsOptions {
  /** Packages that ship uncompiled StyleX source and must be compiled by us. */
  readonly externalPackages?: readonly string[]
  /**
   * Absolute paths of the build entries that should receive the virtual
   * stylesheet import. One per surface: the library/app entry, and the
   * Storybook preview when the package has stories.
   */
  readonly entries: readonly string[]
}

/**
 * Shared StyleX Vite integration: compiled CSS enters the bundle as a virtual
 * CSS module in the module graph rather than by picking an emitted asset by
 * filename.
 */
export declare const createStylexVitePlugins: (options: StylexVitePluginsOptions) => Plugin[]
