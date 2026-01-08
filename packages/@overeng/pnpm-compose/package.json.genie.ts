import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/pnpm-compose',
  version: '0.1.0',
  private: true,
  description: 'CLI for composing pnpm workspaces with git submodules',
  bin: {
    'pnpm-compose': './bin/pnpm-compose',
  },
  type: 'module',
  exports: {
    '.': './src/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './cli': './dist/cli.js',
    },
  },
  devDependencies: {
    '@effect/cli': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/vitest': catalogRef,
    '@types/node': catalogRef,
    effect: catalogRef,
    typescript: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/cli': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    effect: catalogRef,
  },
})
