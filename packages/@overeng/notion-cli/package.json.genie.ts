import {
  catalog,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  name: '@overeng/notion-cli',
  ...privatePackageDefaults,
  scripts: {
    postinstall: patchPostinstall(),
  },
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
  dependencies: {
    ...catalog.pick(
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
    ),
  },
  devDependencies: {
    ...catalog.pick('@effect/vitest', 'effect', 'vitest'),
  },
  // Expose @overeng/utils peer deps transitively (consumers need them)
  peerDependencies: utilsPkg.data.peerDependencies,
})
