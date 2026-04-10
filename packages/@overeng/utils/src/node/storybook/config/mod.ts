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

type StorybookViteFinal<TConfig extends object> = (config: TConfig) => TConfig | Promise<TConfig>

/** Options for `createDomStorybookConfig`. */
export interface DomStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Disable minification (useful for react-inspector to preserve function names) */
  disableMinify?: boolean
}

/** Use when the consuming workspace needs its own local Vite config type for `viteFinal`. */
export interface DomStorybookConfigOptionsWithViteFinal<
  TConfig extends object,
> extends DomStorybookConfigOptions {
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal: StorybookViteFinal<TConfig>
}

/** Options for `createTuiStorybookConfig`. */
export interface TuiStorybookConfigOptions {
  /** Story glob patterns */
  stories?: string[]
  /** Extra addons to include */
  addons?: StorybookConfig['addons']
  /** Additional entries merged into `optimizeDeps.include` (e.g. CJS transitive deps) */
  additionalOptimizeDepsInclude?: string[]
}

/** Use when the consuming workspace needs its own local Vite config type for `viteFinal`. */
export interface TuiStorybookConfigOptionsWithViteFinal<
  TConfig extends object,
> extends TuiStorybookConfigOptions {
  /** Extension hook — runs after the factory transforms for custom overrides */
  viteFinal: StorybookViteFinal<TConfig>
}

const opentuiStubPath = new URL('../opentui-stub.ts', import.meta.url).pathname

/** Apply shared Vite config: server binding, esbuild JSX automatic, optimizeDeps JSX. */
const applySharedConfig = (config: InlineConfig): void => {
  config.server = {
    ...config.server,
    host: '0.0.0.0',
    allowedHosts: true,
    /* Workaround: fsevents 2.3.3 pre-built native binary silently fails to deliver
     * file-change events on macOS 26+, breaking Vite/Storybook HMR.
     * Falls back to Node.js fs.watch (kqueue-based, event-driven — not polling).
     *
     * Root cause: https://github.com/fsevents/fsevents/issues/406
     * Vite is stuck on chokidar v3 (which bundles fsevents) because chokidar v4
     * causes EBADF on macOS: https://github.com/vitejs/vite/issues/18527
     * Upstream tracker for @parcel/watcher alternative: https://github.com/vitejs/vite/issues/13593 */
    watch: { ...config.server?.watch, useFsEvents: false },
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

const callUserViteFinal = async <TConfig extends object>({
  config,
  viteFinal,
}: {
  config: InlineConfig
  viteFinal: StorybookViteFinal<TConfig> | undefined
}): Promise<InlineConfig> => {
  if (viteFinal === undefined) {
    return config
  }

  return (await viteFinal(config as TConfig)) as InlineConfig
}

type CreateDomStorybookConfig = {
  (options?: DomStorybookConfigOptions): StorybookConfig
  <TConfig extends object>(
    options: DomStorybookConfigOptionsWithViteFinal<TConfig>,
  ): StorybookConfig
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
export const createDomStorybookConfig: CreateDomStorybookConfig = <TConfig extends object>(
  options: DomStorybookConfigOptions & {
    viteFinal?: StorybookViteFinal<TConfig>
  } = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    disableMinify = false,
    viteFinal,
  } = options

  const config = {
    stories,
    ...(addons !== undefined ? { addons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (storybookConfig) => {
      const typedConfig = storybookConfig as InlineConfig
      applySharedConfig(typedConfig)

      if (disableMinify === true && typedConfig.build !== undefined) {
        typedConfig.build.minify = false
      } else if (disableMinify === true) {
        typedConfig.build = { minify: false }
      }

      return callUserViteFinal({ config: typedConfig, viteFinal })
    },
  } satisfies StorybookConfig

  return config
}

type CreateTuiStorybookConfig = {
  (options?: TuiStorybookConfigOptions): StorybookConfig
  <TConfig extends object>(
    options: TuiStorybookConfigOptionsWithViteFinal<TConfig>,
  ): StorybookConfig
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
export const createTuiStorybookConfig: CreateTuiStorybookConfig = <TConfig extends object>(
  options: TuiStorybookConfigOptions & {
    viteFinal?: StorybookViteFinal<TConfig>
  } = {},
): StorybookConfig => {
  const {
    stories = ['../src/**/*.stories.@(ts|tsx)'],
    addons,
    additionalOptimizeDepsInclude = [],
    viteFinal,
  } = options

  const config = {
    stories,
    ...(addons !== undefined ? { addons } : {}),
    framework: { name: '@storybook/react-vite', options: {} },
    viteFinal: async (storybookConfig) => {
      const typedConfig = storybookConfig as InlineConfig
      applySharedConfig(typedConfig)

      typedConfig.build = {
        ...typedConfig.build,
        target: 'esnext',
        rollupOptions: {
          ...typedConfig.build?.rollupOptions,
          // eslint-disable-next-line overeng/named-args -- Rollup API signature
          onwarn: (warning, warn) => {
            if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
            warn(warning)
          },
        },
      }

      typedConfig.optimizeDeps = {
        ...typedConfig.optimizeDeps,
        esbuildOptions: {
          ...typedConfig.optimizeDeps?.esbuildOptions,
          target: 'esnext',
        },
      }

      typedConfig.resolve = {
        ...typedConfig.resolve,
        alias: {
          ...typedConfig.resolve?.alias,
          '@opentui/core': opentuiStubPath,
          '@opentui/react': opentuiStubPath,
        },
        dedupe: ['react', 'react-dom', 'react-reconciler'],
      }

      // WORKAROUND: Vite 7+ doesn't properly pre-bundle CJS dependencies of linked workspace
      // packages in dev mode, causing "require is not defined" errors in the browser.
      // Docs: https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies
      // Related: https://github.com/vitejs/vite/issues/10447
      typedConfig.optimizeDeps = {
        ...typedConfig.optimizeDeps,
        include: [
          ...(typedConfig.optimizeDeps?.include ?? []),
          'react-reconciler',
          'react-reconciler > scheduler',
          ...additionalOptimizeDepsInclude,
        ],
        exclude: [...(typedConfig.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
      }

      typedConfig.ssr = {
        ...typedConfig.ssr,
        external: ['@opentui/core', '@opentui/react'],
      }

      return callUserViteFinal({ config: typedConfig, viteFinal })
    },
  } satisfies StorybookConfig

  return config
}
