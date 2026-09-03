// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
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
      'mdast-util-gfm-strikethrough',
      'mdast-util-gfm-table',
      'mdast-util-gfm-task-list-item',
      'micromark-extension-gfm-strikethrough',
      'micromark-extension-gfm-table',
      'micromark-extension-gfm-task-list-item',
      'remark-parse',
      'remark-stringify',
      'unified',
      'unist-util-visit',
    ),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick('@effect/vitest', '@types/node', 'effect', 'typescript', 'vitest'),
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
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './test': exportEntry('./src/test/integration/setup.ts', {
        environment: 'node',
        published: false,
      }),
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
