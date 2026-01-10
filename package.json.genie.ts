import { catalog, patchedDependencies, pkg } from './genie/repo.ts'

export default pkg.root({
  name: 'effect-utils',
  private: true,
  workspaces: {
    packages: ['packages/**', 'scripts/**', 'context/**'],
    catalog,
  },
  type: 'module',
  patchedDependencies,
  scripts: {
    prepare: 'effect-language-service patch || true',
  },
  devDependencies: [
    // TODO get rid of lib deps from effect-utils root START
    '@effect/cli',
    '@effect/language-service',
    '@effect/platform',
    '@effect/platform-node',
    '@effect/rpc',
    '@overeng/utils',
    'effect',
    // TODO get rid of lib deps from effect-utils root END
    'oxfmt',
    'oxlint',
    'typescript',
    'vitest',
    // For `playwright` CLI to be available in the dev shell
    '@playwright/test',
  ],
})
