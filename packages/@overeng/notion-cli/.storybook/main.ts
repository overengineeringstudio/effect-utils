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
    config.build = {
      ...config.build,
      target: 'esnext',
    }
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@opentui/core': new URL('./opentui-stub.ts', import.meta.url).pathname,
        '@opentui/react': new URL('./opentui-stub.ts', import.meta.url).pathname,
      },
      dedupe: ['react', 'react-dom', 'react-reconciler'],
      // Ensure browser conditions are used for package exports resolution.
      // This fixes "require is not defined" errors from packages like msgpackr
      // that have separate browser/node entry points.
      conditions: ['browser', 'import', 'module', 'default'],
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
      },
      include: [...(config.optimizeDeps?.include ?? []), 'react-reconciler'],
      // Exclude @opentui packages and msgpackr to ensure browser conditions are respected
      exclude: [
        ...(config.optimizeDeps?.exclude ?? []),
        '@opentui/core',
        '@opentui/react',
        'msgpackr',
        'msgpackr-extract',
      ],
    }
    config.ssr = {
      ...config.ssr,
      external: ['@opentui/core', '@opentui/react'],
    }
    return config
  },
}

export default config
