import { defineCargoBuck2PackageProjection } from '../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const fixtureRoot = 'scripts/fixtures/rust-foreign'
const projectWorkspace = ({
  workspace,
  members,
}: {
  readonly workspace: 'a' | 'b'
  readonly members: readonly string[]
}) =>
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

/** Consumer fixture projection. */
export const consumerProjection = projectWorkspace({
  workspace: 'a',
  members: ['Cargo.toml', 'app/Cargo.toml'],
})
/** Provider fixture projection. */
export const providerProjection = projectWorkspace({
  workspace: 'b',
  members: ['crates/shared/Cargo.toml'],
})
