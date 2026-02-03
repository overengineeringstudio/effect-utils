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
    // Configure esbuild to use automatic JSX runtime for all files
    // This is needed for linked workspace packages that use jsx: "react-jsx"
    config.esbuild = {
      ...config.esbuild,
      jsx: 'automatic',
    }
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@opentui/core': new URL('./opentui-stub.ts', import.meta.url).pathname,
        '@opentui/react': new URL('./opentui-stub.ts', import.meta.url).pathname,
      },
      dedupe: ['react', 'react-dom', 'react-reconciler'],
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      esbuildOptions: {
        target: 'esnext',
        jsx: 'automatic',
      },
      // WORKAROUND: Vite 7+ doesn't properly pre-bundle CJS dependencies of linked workspace
      // packages in dev mode, causing "require is not defined" errors in the browser.
      // Docs: https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies
      // Related: https://github.com/vitejs/vite/issues/10447
      include: [
        ...(config.optimizeDeps?.include ?? []),
        'react-reconciler',
        'react-reconciler > scheduler',
        '@effect/cli > ini',
        '@effect/cli > toml',
      ],
      // Exclude @opentui packages - they require Bun runtime
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
