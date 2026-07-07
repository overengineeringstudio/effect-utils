// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const packagedEffectRuntimeClosureDeps = [
  // The packaged CLI can resolve Effect modules through nested workspace package node_modules
  // (e.g. @overeng/utils/node_modules/@effect/platform). Expose the Effect-owned runtime
  // closure at the packaged root so those nested imports do not depend on hoisted dev state.
  '@effect/sql',
  '@effect/typeclass',
  'fast-check',
  'find-my-way-ts',
  'ini',
  'mime',
  'msgpackr',
  'multipasta',
  'pure-rand',
  'toml',
  'undici',
  'ws',
  'yaml',
] as const

const packagedTuiRuntimeClosureDeps = [
  // @overeng/tui-react is injected into the packaged Genie workspace. Its direct deps are
  // declared by tui-react; expose the terminal text runtime sidecars reached through
  // cli-truncate/string-width at the packaged root.
  'ansi-regex',
  'emoji-regex',
  'get-east-asian-width',
  'scheduler',
  'slice-ansi',
  'strip-ansi',
] as const

const supportDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/genie' }),
  dependencies: {
    workspace: [otelContractPkg, tuiReactPkg, utilsPkg],
    external: catalog.pick(
      'typescript',
      ...packagedEffectRuntimeClosureDeps,
      ...packagedTuiRuntimeClosureDeps,
    ),
  },
  devDependencies: {
    workspace: [tuiCorePkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        '@effect/cli',
        '@effect/platform',
        '@effect/platform-node',
        '@effect/platform-node-shared',
        '@effect/printer',
        '@effect/printer-ansi',
        '@effect/vitest',
        '@types/node',
        '@types/bun',
        'vitest',
        '@storybook/react',
        '@storybook/react-vite',
        'storybook',
        '@types/react',
        '@types/react-reconciler',
        'prettier',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick('@effect/cli'),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/genie',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6008',
      'storybook:build': 'storybook build',
    },
    exports: {
      // Isomorphic entry: pure builders + types, free of node/Bun/DOM in their import closure. A TYPECHECKING
      // consumer (e.g. a `.bzl` genie generator) can import `GenieOutput`/`Strict` and the builders without
      // dragging genie's runtime ambient globals into its program. Filesystem/spawn capabilities used during
      // validation are injected via `GenieContext` (`io`, `actionlint`) by the engine.
      '.': exportEntry('./src/runtime/mod.ts', {
        environment: 'isomorphic-es2024',
        typeProof: 'strict',
      }),
      // Node-resident entry: re-exports `.` plus the node-only members (nodeGenieIO, actionlint runner,
      // github-ruleset reconcile ops, fs-discovery tsconfigJsonFromPackages, repo-context).
      './node': exportEntry('./src/runtime/node/mod.ts', { environment: 'node' }),
      // Explicit reusable composition layer. Keep `.` focused on thin artifact builders; put cross-artifact
      // helpers that consume structured Genie metadata here.
      './composition': exportEntry('./src/runtime/composition/mod.ts', {
        environment: 'isomorphic-es2024',
      }),
      './cli': exportEntry('./src/build/mod.tsx', { environment: 'node' }),
      './sdk': exportEntry('./src/sdk/mod.ts', { environment: 'node' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/runtime/mod.js',
        './node': './dist/src/runtime/node/mod.js',
        './composition': './dist/src/runtime/composition/mod.js',
        './cli': './dist/src/build/mod.js',
        './sdk': './dist/src/sdk/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  supportDeps,
)
