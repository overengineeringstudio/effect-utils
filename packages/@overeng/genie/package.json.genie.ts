import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from './src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/genie',
  version: '0.1.0',
  private: true,
  bin: {
    genie: './bin/genie',
  },
  type: 'module',
  exports: {
    '.': './src/lib/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/lib/mod.js',
      './cli': './dist/cli.js',
    },
  },
  devDependencies: {
    '@effect/cli': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@types/node': catalogRef,
    effect: catalogRef,
    typescript: catalogRef,
  },
  peerDependencies: {
    '@effect/cli': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    effect: catalogRef,
  },
})
