import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)', '../examples/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (config) => {
    // Allow access from any host (for remote dev servers)
    config.server = {
      ...config.server,
      host: '0.0.0.0',
      allowedHosts: true,
    }
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
      // Also exclude msgpackr to ensure browser conditions are respected
      exclude: ['@opentui/core', '@opentui/react', 'msgpackr', 'msgpackr-extract'],
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
      // Ensure browser conditions are used for package exports resolution.
      // This fixes "require is not defined" errors from packages like msgpackr
      // that have separate browser/node entry points.
      conditions: ['browser', 'import', 'module', 'default'],
    }
    return config
  },
}

export default config
