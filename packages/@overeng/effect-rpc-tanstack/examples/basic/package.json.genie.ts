import {
  bunWorkspacesWithDeps,
  catalog,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../../../genie/internal.ts'
import utilsPkg from '../../../utils/package.json.genie.ts'

const data = {
  name: 'effect-rpc-tanstack-example-basic',
  ...privatePackageDefaults,
  scripts: {
    dev: 'vite',
    build: 'vite build',
    start: 'node .output/server/index.mjs',
    'test:e2e': 'playwright test',
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
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [utilsPkg],
    location: 'packages/@overeng/effect-rpc-tanstack/examples/basic',
  }),
} satisfies PackageJsonData)
