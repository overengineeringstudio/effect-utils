import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/notion-effect-cli',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
    './config': './src/config-def.ts',
  },
  publishConfig: {
    access: 'public',
    bin: {
      'notion-effect-cli': './dist/cli.js',
    },
    exports: {
      '.': './dist/mod.js',
      './config': './dist/config-def.js',
    },
  },
  dependencies: {
    '@effect/cli': catalogRef,
    '@effect/cluster': catalogRef,
    '@effect/experimental': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/printer': catalogRef,
    '@effect/printer-ansi': catalogRef,
    '@effect/rpc': catalogRef,
    '@effect/sql': catalogRef,
    '@effect/typeclass': catalogRef,
    '@effect/workflow': catalogRef,
    '@overeng/notion-effect-client': 'workspace:*',
    '@overeng/notion-effect-schema': 'workspace:*',
    '@overeng/utils': 'workspace:*',
  },
  devDependencies: {
    '@effect/vitest': catalogRef,
    effect: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    effect: catalogRef,
  },
})
