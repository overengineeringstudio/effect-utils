import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/vitest',
  'effect',
  'vitest',
] as const

const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/utils-dev' }),
  devDependencies: {
    external: {
      ...catalog.pick(...peerDepNames, '@types/node', 'typescript'),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/utils-dev',
    ...privatePackageDefaults,
    exports: {
      './node-vitest': './src/node-vitest/mod.ts',
      './node-vitest/setup-fast-check': './src/node-vitest/setup-fast-check.ts',
      './otelite': './src/otelite/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        './node-vitest': './dist/node-vitest/mod.js',
        './node-vitest/setup-fast-check': './dist/node-vitest/setup-fast-check.js',
        './otelite': './dist/otelite/mod.js',
      },
    },
  },
  deps,
)
