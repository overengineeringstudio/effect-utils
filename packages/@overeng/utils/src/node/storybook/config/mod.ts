/**
 * Storybook config factory for consistent Vite-based Storybook setups.
 *
 * Centralizes shared Vite config (JSX, server, optimizeDeps) and TUI-specific
 * workarounds (OpenTUI stubs, React deduplication, CJS pre-bundling).
 *
 * @module
 */

import type { StorybookConfig } from '@storybook/react-vite'
import type { InlineConfig } from 'vite'

/** `'dom'` for browser-rendered React, `'tui'` for terminal UI (adds OpenTUI stubs + esnext) */
export type StorybookVariant = 'dom' | 'tui'

/** Options for `createStorybookConfig`. */
export interface StorybookConfigOptions {
  /** Storybook variant — `'dom'` (default) or `'tui'` (adds OpenTUI stubs, React dedupe, esnext) */
  variant?: StorybookVariant
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Additional entries merged into `optimizeDeps.include` (e.g. CJS transitive deps) */
  additionalOptimizeDepsInclude?: string[]
  /** Disable minification (useful for react-inspector to preserve function names) */
  disableMinify?: boolean
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal?: (config: InlineConfig) => InlineConfig | Promise<InlineConfig>
}

const opentuiStubPath = new URL('../opentui-stub.ts', import.meta.url).pathname

/**
 * Create a Storybook config with shared best practices.
 *
 * @example
 * ```typescript
 * // DOM package — minimal config
 * import { createStorybookConfig } from '@overeng/utils/node/storybook/config'
 * export default createStorybookConfig({})
 *
 * // TUI package with extra CJS deps
 * export default createStorybookConfig({
 *   variant: 'tui',
 *   additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
 * })
 * ```
 */
export const createStorybookConfig = (options: StorybookConfigOptions = {}): StorybookConfig => {
  const {
    variant = 'dom',
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    additionalOptimizeDepsInclude = [],
    disableMinify = false,
    viteFinal: userViteFinal,
  } = options

  return {
    stories,
    ...(addons ? { addons } : {}),
    framework: {
      name: '@storybook/react-vite',
      options: {},
    },
    viteFinal: async (config) => {
      // --- Shared: server ---
      config.server = {
        ...config.server,
        host: '0.0.0.0',
        allowedHosts: true,
      }

      // --- Shared: esbuild JSX automatic ---
      config.esbuild = {
        ...config.esbuild,
        jsx: 'automatic',
      }

      // --- Shared: optimizeDeps esbuild JSX ---
      config.optimizeDeps = {
        ...config.optimizeDeps,
        esbuildOptions: {
          ...config.optimizeDeps?.esbuildOptions,
          jsx: 'automatic',
          ...(variant === 'tui' ? { target: 'esnext' } : {}),
        },
      }

      // --- TUI-specific ---
      if (variant === 'tui') {
        config.build = {
          ...config.build,
          target: 'esnext',
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
      } else if (additionalOptimizeDepsInclude.length > 0) {
        config.optimizeDeps = {
          ...config.optimizeDeps,
          include: [...(config.optimizeDeps?.include ?? []), ...additionalOptimizeDepsInclude],
        }
      }

      // --- disableMinify ---
      if (disableMinify && config.build) {
        config.build.minify = false
      } else if (disableMinify) {
        config.build = { minify: false }
      }

      // --- User extension hook ---
      if (userViteFinal) {
        return userViteFinal(config)
      }

      return config
    },
  }
}
