// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
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
      './node-vitest': exportEntry(
        { types: './dist/src/node-vitest/mod.d.ts', default: './src/node-vitest/mod.ts' },
        { environment: 'node' },
      ),
      './otelite': exportEntry(
        { types: './dist/src/otelite/mod.d.ts', default: './src/otelite/mod.ts' },
        { environment: 'node' },
      ),
      './cli-contract': exportEntry(
        { types: './dist/src/cli-contract.d.ts', default: './src/cli-contract.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        './node-vitest': {
          types: './dist/src/node-vitest/mod.d.ts',
          default: './dist/src/node-vitest/mod.js',
        },
        './node-vitest/setup-fast-check': {
          types: './dist/src/node-vitest/setup-fast-check.d.ts',
          default: './dist/src/node-vitest/setup-fast-check.js',
        },
        './otelite': { types: './dist/src/otelite/mod.d.ts', default: './dist/src/otelite/mod.js' },
        './cli-contract': {
          types: './dist/src/cli-contract.d.ts',
          default: './dist/src/cli-contract.js',
        },
      },
    },
  },
  deps,
)
