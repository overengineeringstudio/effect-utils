import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/notion-cli',
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
      notion: './dist/cli.js',
    },
    exports: {
      '.': './dist/mod.js',
      './config': './dist/config-def.js',
    },
  },
  dependencies: [
    '@effect/cli',
    '@effect/cluster',
    '@effect/experimental',
    '@effect/platform',
    '@effect/platform-node',
    '@effect/printer',
    '@effect/printer-ansi',
    '@effect/rpc',
    '@effect/sql',
    '@effect/typeclass',
    '@effect/workflow',
    '@overeng/notion-effect-client',
    '@overeng/notion-effect-schema',
    '@overeng/utils',
  ],
  devDependencies: ['@effect/vitest', 'effect', 'vitest'],
  peerDependencies: {
    effect: '^',
  },
})
