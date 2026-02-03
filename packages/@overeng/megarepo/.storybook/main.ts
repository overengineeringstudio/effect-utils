import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
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
    config.resolve = {
      ...config.resolve,
      // Alias OpenTUI to empty modules in browser - they require Bun runtime
      alias: {
        ...config.resolve?.alias,
        '@opentui/core': new URL('./opentui-stub.ts', import.meta.url).pathname,
        '@opentui/react': new URL('./opentui-stub.ts', import.meta.url).pathname,
      },
      // IMPORTANT: Dedupe React packages to avoid multiple instances.
      // This package uses @overeng/tui-react which uses react-reconciler for its TUI renderer.
      // React-reconciler shares React's internal dispatcher with react-dom. Without deduplication,
      // Vite may resolve these packages to different copies in the monorepo,
      // causing "Cannot read properties of null (reading 'useState')" errors.
      dedupe: ['react', 'react-dom', 'react-reconciler'],
      // Ensure browser conditions are used for package exports resolution.
      // This fixes "require is not defined" errors from packages like msgpackr
      // that have separate browser/node entry points.
      conditions: ['browser', 'import', 'module', 'default'],
    }
    // Exclude OpenTUI packages from optimization - they require Bun runtime
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
      },
      include: [...(config.optimizeDeps?.include ?? []), 'react-reconciler'],
      exclude: [...(config.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
    }
    // Also exclude from SSR
    config.ssr = {
      ...config.ssr,
      external: ['@opentui/core', '@opentui/react'],
    }
    return config
  },
}

export default config
