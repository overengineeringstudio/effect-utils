import { catalog, catalogRef } from './genie/repo.ts'
import { packageJSON } from './packages/@overeng/genie/src/lib/mod.ts'

export default packageJSON({
  name: 'effect-notion',
  private: true,
  workspaces: ['packages/**', 'scripts/**', 'context/**'],
  type: 'module',
  scripts: {
    prepare: 'effect-language-service patch || true',
  },
  devDependencies: {
    '@effect/cli': catalogRef,
    '@effect/language-service': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@overeng/utils': 'workspace:*',
    effect: catalogRef,
    oxfmt: '0.21.0',
    oxlint: '1.36.0',
    typescript: catalogRef,
    vitest: catalogRef,
  },
  catalog,
  patchedDependencies: {
    'effect-distributed-lock@0.0.11': 'patches/effect-distributed-lock@0.0.11.patch',
  },
})
