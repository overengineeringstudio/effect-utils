import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)', '../examples/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (config) => {
    // Ensure we're using esnext for top-level await support
    config.build = {
      ...config.build,
      target: 'esnext',
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
      },
      // Exclude OpenTUI packages - they require Bun runtime and special import syntax
      exclude: ['@opentui/core', '@opentui/react'],
    }
    // Also exclude from SSR
    config.ssr = {
      ...config.ssr,
      noExternal: [],
      external: ['@opentui/core', '@opentui/react'],
    }
    // Alias OpenTUI to empty modules in browser
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@opentui/core': new URL('../src/storybook/opentui-stub.ts', import.meta.url).pathname,
        '@opentui/react': new URL('../src/storybook/opentui-stub.ts', import.meta.url).pathname,
      },
      // IMPORTANT: Dedupe React packages to avoid multiple instances.
      // This package uses react-reconciler for its TUI renderer, which shares
      // React's internal dispatcher with react-dom. Without deduplication,
      // Vite may resolve these packages to different copies in the monorepo,
      // causing "Cannot read properties of null (reading 'useState')" errors.
      // Other Storybook packages in this monorepo don't need this because they
      // only use react-dom, not react-reconciler.
      dedupe: ['react', 'react-dom', 'react-reconciler'],
    }
    return config
  },
}

export default config
