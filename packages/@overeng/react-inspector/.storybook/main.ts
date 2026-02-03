import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../stories/*.*'],
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
    // Disable minification to preserve function names
    if (config.build) {
      config.build.minify = false
    }
    return config
  },
}

export default config
