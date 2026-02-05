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
    // Configure esbuild to use automatic JSX runtime for all files
    // This is needed for linked workspace packages that use jsx: "react-jsx"
    config.esbuild = {
      ...config.esbuild,
      jsx: 'automatic',
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
      dedupe: ['react', 'react-dom', 'react-reconciler'],
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
        jsx: 'automatic',
      },
      include: [
        ...(config.optimizeDeps?.include ?? []),
        'react-reconciler',
        'react-reconciler > scheduler',
        '@effect/cli > ini',
        '@effect/cli > toml',
      ],
      exclude: [...(config.optimizeDeps?.exclude ?? []), '@opentui/core', '@opentui/react'],
    }
    config.ssr = {
      ...config.ssr,
      external: ['@opentui/core', '@opentui/react'],
    }
    return config
  },
}

export default config
