import { pkg } from './genie/repo.ts'

export default pkg({
  name: 'effect-notion',
  private: true,
  workspaces: ['packages/**', 'scripts/**', 'context/**'],
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
  pnpm: {
    patchedDependencies: {
      'effect-distributed-lock@0.0.11': 'patches/effect-distributed-lock@0.0.11.patch',
    },
  },
})
