import { catalog, packageJson, patchPostinstall } from '../genie/internal.ts'

export default packageJson({
  name: 'effect-utils-scripts',
  private: true,
  type: 'module',
  scripts: {
    postinstall: patchPostinstall(),
  },
  dependencies: {
    ...catalog.pick(
      '@overeng/genie',
      '@overeng/mono',
      '@overeng/utils',
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/workflow',
      '@mariozechner/pi-tui',
      'effect',
    ),
  },
  devDependencies: {
    ...catalog.pick('@types/bun', '@types/node', 'typescript'),
  },
})
