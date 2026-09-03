import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_notion_react_7158c0aeaa96',
  packageName: '@overeng/notion-react',
  packagePath: 'packages/@overeng/notion-react',
  projectionSource: 'packages/@overeng/notion-react/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/notion-effect-client',
      packagePath: 'packages/@overeng/notion-effect-client',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/notion-effect-schema',
      packagePath: 'packages/@overeng/notion-effect-schema',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
  ],
  editorViewConsumer: false,
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
