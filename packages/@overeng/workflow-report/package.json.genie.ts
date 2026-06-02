import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/workflow-report' }),
  devDependencies: {
    workspace: [utilsDevPkg, utilsPkg],
    external: catalog.pick(
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/vitest',
      '@types/bun',
      '@types/node',
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: {
    workspace: [utilsPkg],
    external: catalog.pick('@effect/cli'),
  },
})

export default packageJson(
  {
    name: '@overeng/workflow-report',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './cli': './src/cli-command.ts',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'workflow-report': './dist/bin/workflow-report.js',
      },
      exports: {
        '.': './dist/src/mod.js',
        './cli': './dist/src/cli-command.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
