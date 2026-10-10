// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import aiGatewayConformancePkg from '../ai-gateway-conformance/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect', '@effect/ai-openai-compat', '@effect/ai-typesafe'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-ai-gateway' }),
  devDependencies: {
    workspace: [utilsDevPkg, aiGatewayConformancePkg],
    external: {
      ...catalog.pick(
        '@effect/vitest',
        '@effect/platform-node',
        '@types/node',
        'typescript',
        'effect',
        '@effect/ai-openai-compat',
        '@effect/ai-typesafe',
        'vite',
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
    name: '@overeng/effect-ai-gateway',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
