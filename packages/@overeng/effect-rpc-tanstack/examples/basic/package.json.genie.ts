import { catalog, packageJson, patchPostinstall, privatePackageDefaults } from '../../../../../genie/internal.ts'

export default packageJson({
  name: 'effect-rpc-tanstack-example-basic',
  ...privatePackageDefaults,
  scripts: {
    dev: 'vite',
    build: 'vite build',
    start: 'node .output/server/index.mjs',
    'test:e2e': 'playwright test',
    postinstall: patchPostinstall(),
  },
  dependencies: {
    ...catalog.pick(
      '@effect/platform',
      '@effect/rpc',
      '@tanstack/react-router',
      '@tanstack/react-start',
      'effect',
      'react',
      'react-dom',
    ),
  },
  devDependencies: {
    ...catalog.pick(
      '@overeng/utils',
      '@playwright/test',
      '@tanstack/router-plugin',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'typescript',
      'vite',
    ),
  },
})
