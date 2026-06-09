import { otelSdkDeps } from '../../../genie/external.ts'
import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

/* The library itself only depends on `effect` and the Restate SDKs; platform
 * deps are not imported here (consumers wire `@effect/platform-node`'s
 * `NodeRuntime.runMain` around `serve`). Keep peers minimal like pty-effect. */
const peerDepNames = ['effect'] as const

/* OTel deps are used ONLY by the `./otel` subpath — the base `.` export must not
 * pull them. They are PEERS (a consumer that imports `./otel` provides them) and
 * also dev deps (so the package builds + the OTel test runs locally). This keeps
 * the core dependency-light (decision 0007, spec §10). `@opentelemetry/sdk-metrics`
 * is a peer because the metrics path (decision 0014) imports its
 * `PeriodicExportingMetricReader` / `MetricReader` types directly from `./otel`. */
const otelPeerDepNames = [
  '@effect/opentelemetry',
  '@opentelemetry/api',
  '@opentelemetry/sdk-metrics',
  '@restatedev/restate-sdk-opentelemetry',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/restate-effect' }),
  dependencies: {
    external: catalog.pick('@restatedev/restate-sdk', '@restatedev/restate-sdk-clients'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        ...otelPeerDepNames,
        ...otelSdkDeps,
        '@effect/vitest',
        '@types/node',
        'typescript',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames, ...otelPeerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/restate-effect',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './admin': './src/admin.ts',
      './otel': './src/otel.ts',
      './testing': './src/testing.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './admin': './dist/admin.js',
        './otel': './dist/otel.js',
        './testing': './dist/testing.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
