// @genie-bootstrap
import { otelSdkDeps } from '../../../genie/external.ts'
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/* The library itself only depends on `effect` and the Restate SDKs; platform
 * deps are not imported here (consumers wire `@effect/platform-node`'s
 * `NodeRuntime.runMain` around `serve`). Keep peers minimal like pty-effect. */
const peerDepNames = ['effect'] as const

/* OTel deps are used ONLY by the `./otel` subpath — the base `.` export must not
 * pull them. They are optional PEERS (a consumer that imports `./otel` provides
 * them) and dev deps for local builds/tests. Keep the core dependency-light
 * while declaring every runtime import in the published OTel entry. */
const otelPeerDepNames = [
  '@effect/opentelemetry',
  '@opentelemetry/api',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/semantic-conventions',
  '@restatedev/restate-sdk-opentelemetry',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/restate-effect' }),
  dependencies: {
    workspace: [otelContractPkg, utilsPkg],
    external: catalog.pick('@restatedev/restate-sdk', '@restatedev/restate-sdk-clients'),
  },
  devDependencies: {
    /* utils-dev supplies test helpers; utils is a runtime dependency because
     * Serde, RestateError and the exported testing harness import it. */
    workspace: [utilsDevPkg],
    /* Keep utils linked live rather than freezing pnpm's injected snapshot:
     * pnpm 12 ignores dependenciesMeta.injected: false under the workspace-wide
     * injection setting, so the path-based workspace specifier is required. */
    liveWorkspaceLinks: ['@overeng/utils'],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        ...otelPeerDepNames,
        ...otelSdkDeps,
        '@effect/vitest',
        '@effect/platform-node',
        '@playwright/test',
        '@storybook/react-vite',
        '@vitest/browser-playwright',
        'storybook',
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
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './admin': exportEntry(
        { types: './dist/src/admin/admin.d.ts', default: './src/admin/admin.ts' },
        { environment: 'node' },
      ),
      './otel': exportEntry(
        { types: './dist/src/observability/otel.d.ts', default: './src/observability/otel.ts' },
        { environment: 'node' },
      ),
      './testing': exportEntry(
        { types: './dist/src/testing/testing.d.ts', default: './src/testing/testing.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './admin': './dist/admin/admin.js',
        './otel': './dist/observability/otel.js',
        './testing': './dist/testing/testing.js',
      },
    },
    peerDependenciesMeta: Object.fromEntries(
      otelPeerDepNames.map((name) => [name, { optional: true }]),
    ),
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
