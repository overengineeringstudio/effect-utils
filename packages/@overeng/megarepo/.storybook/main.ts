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
        jsx: 'automatic', // Use automatic JSX runtime (React 17+)
      },
      // WORKAROUND: Vite 7+ doesn't properly pre-bundle CJS dependencies of linked workspace
      // packages in dev mode, causing "require is not defined" errors in the browser.
      //
      // When a linked workspace package (e.g., @overeng/tui-react) imports a dependency
      // (e.g., react-reconciler) that has CJS transitive dependencies (e.g., scheduler),
      // Vite fails to include those transitive deps in the pre-bundle.
      //
      // The fix is to explicitly include CJS dependencies using the nested dependency syntax.
      // Production builds are unaffected as Rollup handles CJS differently than esbuild.
      //
      // Docs: https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies
      // Related: https://github.com/vitejs/vite/issues/10447
      include: [
        ...(config.optimizeDeps?.include ?? []),
        'react-reconciler',
        'react-reconciler > scheduler', // CJS dep of react-reconciler
        '@effect/cli > ini', // CJS dep of @effect/cli
        '@effect/cli > toml', // CJS dep of @effect/cli
      ],
      // Exclude OpenTUI packages - they require Bun runtime
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
