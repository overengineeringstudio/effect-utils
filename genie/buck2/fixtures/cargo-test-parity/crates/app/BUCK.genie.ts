import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineCargoBuck2PackageProjection } from '../../../../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

// Resolve the disposable copy's name, not the checked-in fixture's name.
const workspaceRoot = `genie/buck2/fixtures/${basename(fileURLToPath(new URL('../..', import.meta.url)))}`
const packagePath = `${workspaceRoot}/crates/app`
export default defineCargoBuck2PackageProjection({
  repoName: 'effect-utils',
  repoImportMetaUrl: import.meta.url,
  workspaceRoot,
  workspaceMemberManifestPaths: [`${packagePath}/Cargo.toml`],
  testPackagePaths: [packagePath],
  thirdPartyBuckPath: `${workspaceRoot}/vendor/BUCK`,
  thirdPartyPackage: `//${workspaceRoot}/vendor`,
  generatorSourcePaths: [],
})({
  sourceUrl: import.meta.url,
  compileTimeResources: [
    {
      path: `${workspaceRoot}/fixtures/message.txt`,
      label: `//${workspaceRoot}:message`,
      destination: { kind: 'repository', path: `${workspaceRoot}/fixtures/message.txt` },
    },
    {
      path: `${workspaceRoot}/crates/assets/blob.bin`,
      label: `//${workspaceRoot}/crates/assets:blob`,
      destination: { kind: 'repository', path: `${workspaceRoot}/crates/assets/blob.bin` },
    },
  ],
  runtimeResources: [
    {
      path: `${workspaceRoot}/ancestor-script.sh`,
      label: `//${workspaceRoot}:ancestor-script`,
      destination: { kind: 'repository', path: `${workspaceRoot}/ancestor-script.sh` },
    },
    {
      label: `//${workspaceRoot}:generated-resource`,
      destination: { kind: 'repository', path: `${workspaceRoot}/fixtures/generated.txt` },
    },
  ],
})
