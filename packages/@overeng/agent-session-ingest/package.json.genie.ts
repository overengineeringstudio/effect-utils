import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['@effect/platform', 'effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/agent-session-ingest'),
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/platform-node',
        '@effect/vitest',
        '@types/node',
        'typescript',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
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
  } satisfies PackageJsonData,
  workspaceDeps,
)
