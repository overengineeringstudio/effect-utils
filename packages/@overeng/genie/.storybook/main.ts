import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  // Note: In storybook 10.x, addon-essentials is built into the core
  addons: [],
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
    config.resolve = {
      ...config.resolve,
      // IMPORTANT: Dedupe React packages to avoid multiple instances.
      // This package uses @overeng/tui-react which uses react-reconciler for its TUI renderer.
      // React-reconciler shares React's internal dispatcher with react-dom. Without deduplication,
      // Vite may resolve these packages to different copies in the monorepo,
      // causing "Cannot read properties of null (reading 'useState')" errors.
      dedupe: ['react', 'react-dom', 'react-reconciler'],
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
      },
      include: [...(config.optimizeDeps?.include ?? []), 'react-reconciler'],
      // Exclude @opentui packages - they use `with { type: "file" }` import attributes
      // that esbuild doesn't support
      exclude: [...(config.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
    }
    return config
  },
}

export default config
