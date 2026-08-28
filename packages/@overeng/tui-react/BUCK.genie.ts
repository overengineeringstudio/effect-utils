import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export default buck2TypeScriptPackageProjection({
  packageName: '@overeng/tui-react',
  packagePath: 'packages/@overeng/tui-react',
  projectionSource: 'packages/@overeng/tui-react/BUCK.genie.ts',
  projectFile: 'tsconfig.buck.json',
  sourceRoots: ['src', 'test', 'examples'],
  patches: ['packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch'],
  workspaceSiblings: [
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: 'effect_utils//packages/@overeng/tui-core:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      sourceRoots: ['src'],
    },
  ],
})
