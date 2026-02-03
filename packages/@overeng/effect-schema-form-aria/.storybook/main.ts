import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (config) => {
    config.server = {
      ...config.server,
      host: '0.0.0.0',
      allowedHosts: true,
    }
    // Configure esbuild to use automatic JSX runtime for linked workspace packages
    config.esbuild = {
      ...config.esbuild,
      jsx: 'automatic',
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        jsx: 'automatic',
      },
    }
    return config
  },
}

export default config
