import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export default buck2TypeScriptPackageProjection({
  packageName: '@overeng/tui-core',
  packagePath: 'packages/@overeng/tui-core',
  projectionSource: 'packages/@overeng/tui-core/BUCK.genie.ts',
  sourceRoots: ['src', 'test'],
  patches: ['packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch'],
})
