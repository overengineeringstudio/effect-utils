import { catalog, pkg } from './genie/repo.ts'

export default pkg.root({
  name: 'effect-utils',
  private: true,
  workspaces: {
    packages: ['packages/**', 'scripts/**', 'context/**'],
    catalog,
  },
  type: 'module',
  scripts: {
    prepare: 'effect-language-service patch || true',
  },
  devDependencies: [
    '@effect/cli',
    '@effect/language-service',
    '@effect/platform',
    '@effect/platform-node',
    '@effect/rpc',
    '@overeng/utils',
    'effect',
    'oxfmt',
    'oxlint',
    'typescript',
    'vitest',
  ],
})
