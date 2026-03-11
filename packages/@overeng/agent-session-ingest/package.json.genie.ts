import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const peerDepNames = ['@effect/platform', 'effect'] as const

export default packageJson({
  name: '@overeng/agent-session-ingest',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './codex': './src/adapters/codex.ts',
    './claude': './src/adapters/claude.ts',
    './opencode': './src/adapters/opencode.ts',
    './jsonl': './src/adapters/jsonl.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './codex': './dist/adapters/codex.js',
      './claude': './dist/adapters/claude.js',
      './opencode': './dist/adapters/opencode.js',
      './jsonl': './dist/adapters/jsonl.js',
    },
  },
  pnpm: {
    patchedDependencies: {},
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@effect/platform-node',
      '@effect/vitest',
      '@overeng/utils-dev',
      '@types/node',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
