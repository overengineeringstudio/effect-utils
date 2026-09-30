import { defineCargoBuck2PackageProjection } from '../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const fixtureRoot = 'scripts/fixtures/rust-foreign'
const projectWorkspace = (workspace: 'a' | 'b', members: readonly string[]) =>
  defineCargoBuck2PackageProjection({
    repoName: 'effect-utils',
    repoImportMetaUrl: import.meta.url,
    workspaceRoot: `${fixtureRoot}/${workspace}`,
    workspaceMemberManifestPaths: members.map((member) => `${fixtureRoot}/${workspace}/${member}`),
    thirdPartyPackage: `//${fixtureRoot}/${workspace}/third-party`,
    generatorSourcePaths: [
      'genie/buck2/mod.ts',
      'rust/buck2-tools/core/cargo-buck2-package-projection.ts',
      'scripts/fixtures/rust-foreign/projection.ts',
    ],
  })

export const consumerProjection = projectWorkspace('a', ['Cargo.toml', 'app/Cargo.toml'])
export const providerProjection = projectWorkspace('b', ['crates/shared/Cargo.toml'])
