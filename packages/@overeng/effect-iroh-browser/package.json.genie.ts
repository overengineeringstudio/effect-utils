// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  publishedSourceExport,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-iroh-browser' }),
  devDependencies: {
    external: catalog.pick('effect', '@effect/vitest', '@types/node', 'typescript', 'vitest'),
  },
  peerDependencies: { external: catalog.pick('effect') },
})

export default packageJson(
  {
    name: '@overeng/effect-iroh-browser',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './testing': exportEntry(
        { types: './dist/src/testing.d.ts', default: './src/testing.ts' },
        { environment: 'browser' },
      ),
      './download': exportEntry(
        { types: './dist/src/download.d.ts', default: './src/download.ts' },
        { environment: 'browser' },
      ),
      './wasm': exportEntry(
        { types: './wasm/games_iroh_wasm.d.ts', default: './wasm/games_iroh_wasm.js' },
        { environment: 'browser' },
      ),
      './wasm/iroh.wasm': exportEntry('./wasm/games_iroh_wasm_bg.wasm', { environment: 'browser' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': publishedSourceExport('mod'),
        './testing': publishedSourceExport('testing'),
        './download': publishedSourceExport('download'),
        './wasm': { types: './wasm/games_iroh_wasm.d.ts', default: './wasm/games_iroh_wasm.js' },
        './wasm/iroh.wasm': './wasm/games_iroh_wasm_bg.wasm',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
