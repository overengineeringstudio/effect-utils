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
  '@effect/platform',
  '@effect/platform-node',
  '@effect/vitest',
  'effect',
  'vitest',
] as const

/**
 * Runtime deps the test harness itself pulls in (not consumer-provided peers):
 * the Vitest native-OTEL `sdkPath` module builds a NodeTracerProvider + OTLP
 * exporter, and the Vitest→Effect parent bridge reads the active span via the
 * OpenTelemetry API.
 */
const otelRuntimeDepNames = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/exporter-trace-otlp-http',
] as const

const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/utils-dev' }),
  dependencies: {
    external: catalog.pick(...otelRuntimeDepNames),
  },
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
      './node-vitest': exportEntry('./src/node-vitest/mod.ts', { environment: 'node' }),
      './node-vitest/setup-fast-check': exportEntry('./src/node-vitest/setup-fast-check.ts', {
        environment: 'node',
      }),
      './otelite': exportEntry('./src/otelite/mod.ts', { environment: 'node' }),
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
