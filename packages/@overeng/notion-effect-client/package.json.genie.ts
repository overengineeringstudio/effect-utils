import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-effect-client' }),
  dependencies: {
    // `@overeng/utils` is a runtime import (`sha256Hex` in `config.ts`), so it
    // must be a real runtime dependency — not a dev/peer dep that a standalone
    // consumer could fail to provide.
    workspace: [contentAddressPkg, notionCorePkg, notionEffectSchemaPkg, otelContractPkg, utilsPkg],
    external: catalog.pick(
      'remark-gfm',
      'remark-parse',
      'remark-stringify',
      'unified',
      'unist-util-visit',
    ),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        '@effect/platform',
        '@effect/vitest',
        '@types/node',
        'effect',
        'typescript',
        'vitest',
      ),
    },
  },
  // `@overeng/utils` is a runtime workspace dep that carries peer dependencies
  // (the @effect/* cluster + @playwright/test). `mode: 'install'` makes genie
  // install those inherited peers explicitly so a standalone consumer resolves.
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-effect-client',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './test': './src/test/integration/setup.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  },
  runtimeDeps,
)
