import { pkg, privatePackageDefaults } from '../../../../../genie/repo.ts'

export default pkg.package({
  name: 'effect-rpc-tanstack-example-basic',
  ...privatePackageDefaults,
  scripts: {
    dev: 'vite',
    build: 'vite build',
    start: 'node .output/server/index.mjs',
    'test:e2e': 'playwright test',
  },
  dependencies: [
    '@effect/platform',
    '@effect/rpc',
    '@tanstack/react-router',
    '@tanstack/react-start',
    'effect',
    'react',
    'react-dom',
  ],
  devDependencies: [
    '@overeng/utils',
    '@playwright/test',
    '@tanstack/router-plugin',
    '@types/node',
    '@types/react',
    '@types/react-dom',
    '@vitejs/plugin-react',
    'typescript',
    'vite',
  ],
})
