// @genie-bootstrap
import { catalog, exportEntry, packageJson, privatePackageDefaults, workspaceMember, type PackageJsonInputData } from '../../../genie/internal.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-rust' }),
  dependencies: { external: catalog.pick('effect') },
  devDependencies: { external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest') },
})

export default packageJson({
  name: '@overeng/effect-rust',
  ...privatePackageDefaults,
  exports: {
    '.': exportEntry({ types: './dist/src/mod.d.ts', default: './src/mod.ts' }, { environment: 'isomorphic-es2024' }),
    './runtime': exportEntry({ types: './dist/src/runtime/interop.d.ts', default: './src/runtime/interop.ts' }, { environment: 'isomorphic-es2024' }),
    './schema': exportEntry({ types: './dist/src/schema/mod.d.ts', default: './src/schema/mod.ts' }, { environment: 'isomorphic-es2024' }),
    './compiler': exportEntry({ types: './dist/src/compiler/mod.d.ts', default: './src/compiler/mod.ts' }, { environment: 'isomorphic-es2024' }),
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
      './runtime': { types: './dist/src/runtime/interop.d.ts', default: './dist/src/runtime/interop.js' },
      './schema': { types: './dist/src/schema/mod.d.ts', default: './dist/src/schema/mod.js' },
      './compiler': { types: './dist/src/compiler/mod.d.ts', default: './dist/src/compiler/mod.js' },
    },
  },
} satisfies PackageJsonInputData, workspaceDeps)
