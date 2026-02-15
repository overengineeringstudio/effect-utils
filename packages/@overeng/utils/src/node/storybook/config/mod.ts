/**
 * Storybook config factories for consistent Vite-based Storybook setups.
 *
 * Two variants:
 * - `createDomStorybookConfig` — browser-rendered React packages
 * - `createTuiStorybookConfig` — terminal UI packages (OpenTUI stubs, React dedupe, esnext)
 *
 * @module
 */

import type { StorybookConfig } from '@storybook/react-vite'
import type { InlineConfig } from 'vite'

/** Options for `createDomStorybookConfig`. */
export interface DomStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Disable minification (useful for react-inspector to preserve function names) */
  disableMinify?: boolean
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal?: (config: InlineConfig) => InlineConfig | Promise<InlineConfig>
}

/** Options for `createTuiStorybookConfig`. */
export interface TuiStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Additional entries merged into `optimizeDeps.include` (e.g. CJS transitive deps) */
  additionalOptimizeDepsInclude?: string[]
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal?: (config: InlineConfig) => InlineConfig | Promise<InlineConfig>
}

const opentuiStubPath = new URL('../opentui-stub.ts', import.meta.url).pathname

/** Apply shared Vite config: server binding, esbuild JSX automatic, optimizeDeps JSX. */
const applySharedConfig = (config: InlineConfig): void => {
  config.server = {
    ...config.server,
    host: '0.0.0.0',
    allowedHosts: true,
  }

  config.esbuild = {
    ...config.esbuild,
    jsx: 'automatic',
  }

  config.optimizeDeps = {
    ...config.optimizeDeps,
    esbuildOptions: {
      ...config.optimizeDeps?.esbuildOptions,
      jsx: 'automatic',
    },
  }
}

/**
 * Create a Storybook config for browser-rendered React packages.
 *
 * @example
 * ```typescript
 * import { createDomStorybookConfig } from '@overeng/utils/node/storybook/config'
 * export default createDomStorybookConfig({})
 * ```
 */
export const createDomStorybookConfig = (
  options: DomStorybookConfigOptions = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    disableMinify = false,
    viteFinal: userViteFinal,
  } = options

  return {
    stories,
    ...(addons !== undefined ? { addons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (config) => {
      applySharedConfig(config)

      if (disableMinify === true && config.build !== undefined) {
        config.build.minify = false
      } else if (disableMinify === true) {
        config.build = { minify: false }
      }

      return userViteFinal !== undefined ? userViteFinal(config) : config
    },
  }
}

/**
 * Create a Storybook config for TUI (terminal UI) packages.
 *
 * Adds OpenTUI stubs, React deduplication, esnext target, and CJS pre-bundling workarounds.
 *
 * @example
 * ```typescript
 * import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'
 * export default createTuiStorybookConfig({
 *   additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
 * })
 * ```
 */
export const createTuiStorybookConfig = (
  options: TuiStorybookConfigOptions = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    additionalOptimizeDepsInclude = [],
    viteFinal: userViteFinal,
  } = options

  return {
    stories,
    ...(addons !== undefined ? { addons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (config) => {
      applySharedConfig(config)

      config.build = {
        ...config.build,
        target: 'esnext',
      }

      config.optimizeDeps = {
        ...config.optimizeDeps,
        esbuildOptions: {
          ...config.optimizeDeps?.esbuildOptions,
          target: 'esnext',
        },
      }

      config.resolve = {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          '@opentui/core': opentuiStubPath,
          '@opentui/react': opentuiStubPath,
        },
        dedupe: ['react', 'react-dom', 'react-reconciler'],
      }

      // WORKAROUND: Vite 7+ doesn't properly pre-bundle CJS dependencies of linked workspace
      // packages in dev mode, causing "require is not defined" errors in the browser.
      // Docs: https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies
      // Related: https://github.com/vitejs/vite/issues/10447
      config.optimizeDeps = {
        ...config.optimizeDeps,
        include: [
          ...(config.optimizeDeps?.include ?? []),
          'react-reconciler',
          'react-reconciler > scheduler',
          ...additionalOptimizeDepsInclude,
        ],
        exclude: [...(config.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
      }

      config.ssr = {
        ...config.ssr,
        external: ['@opentui/core', '@opentui/react'],
      }

      return userViteFinal !== undefined ? userViteFinal(config) : config
    },
  }
}
