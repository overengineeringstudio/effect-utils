import {
  catalog,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/dotdot',
  ...privatePackageDefaults,
  scripts: {
    postinstall: patchPostinstall(),
  },
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
  dependencies: {
    ...catalog.pick('@overeng/utils'),
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/printer',
      '@effect/printer-ansi',
      '@effect/vitest',
      '@types/bun',
      '@types/node',
      'effect',
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: {
    '@effect/cli': `^${catalog['@effect/cli']}`,
    '@effect/platform': `^${catalog['@effect/platform']}`,
    '@effect/platform-node': `^${catalog['@effect/platform-node']}`,
    '@effect/printer': `^${catalog['@effect/printer']}`,
    '@effect/printer-ansi': `^${catalog['@effect/printer-ansi']}`,
    effect: `^${catalog.effect}`,
  },
})
