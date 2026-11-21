import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineCargoBuck2PackageProjection } from '../../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const workspaceRoot = `genie/buck2/fixtures/${basename(fileURLToPath(new URL('.', import.meta.url)))}`
export default defineCargoBuck2PackageProjection({
  repoName: 'effect-utils',
  repoImportMetaUrl: import.meta.url,
  workspaceRoot,
  workspaceMemberManifestPaths: [`${workspaceRoot}/Cargo.toml`],
  testPackagePaths: [workspaceRoot],
  thirdPartyBuckPath: `${workspaceRoot}/vendor/BUCK`,
  thirdPartyPackage: `//${workspaceRoot}/vendor`,
  generatorSourcePaths: [],
})({
  sourceUrl: import.meta.url,
  compileTimeResources: [{ path: `${workspaceRoot}/fixtures/message.txt` }],
})
