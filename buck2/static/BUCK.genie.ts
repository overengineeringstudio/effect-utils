import { pnpmWorkspaceMemberPaths } from '../../genie/packages.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { cargoBuck2WorkspaceMemberPaths } from '../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const declaredPackages = pnpmWorkspaceMemberPaths

const sourceSets = [
  '//:static_sources',
  ...pnpmWorkspaceMemberPaths.map((packagePath) => `//${packagePath}:static_sources`),
].toSorted()

const nixSourceSets = [
  '//:nix_sources',
  ...pnpmWorkspaceMemberPaths.map((packagePath) => `//${packagePath}:nix_sources`),
].toSorted()

const repositorySourceSets = [
  '//:repository_validation_sources',
  '//buck2/static:repository_validation_sources',
  '//buck2/dependencies:static_sources',
  ...sourceSets.slice(1),
  ...cargoBuck2WorkspaceMemberPaths.map((packagePath) => `//${packagePath}:static_sources`),
].toSorted()

for (const [name, labels] of [
  ['Nix source-set census', nixSourceSets],
  ['repository source-set census', repositorySourceSets],
] as const) {
  if (new Set(labels).size !== labels.length) {
    throw new Error(`${name} contains duplicate Buck labels`)
  }
}

if (new Set(sourceSets).size !== sourceSets.length) {
  throw new Error('Static source-set census contains duplicate Buck labels')
}

export default createGenieOutput({
  data: { declaredPackages, nixSourceSets, repositorySourceSets, sourceSets },
  stringify: () => `# Generated file - DO NOT EDIT
# Source: TypeScript admission package boundaries and root static source ownership

load("//buck2:static_checks.bzl", "repository_static_checks", "static_source_set")

static_source_set(
    name = "repository_validation_sources",
    prefix = "buck2/static",
    srcs = ["BUCK.genie.ts"],
    visibility = ["PUBLIC"],
)

repository_static_checks(
    name = "check",
    declared_packages = ${JSON.stringify(declaredPackages, null, 4)},
    source_sets = ${JSON.stringify(sourceSets, null, 4)},
    nix_source_sets = ${JSON.stringify(nixSourceSets, null, 4)},
    repository_source_sets = ${JSON.stringify(repositorySourceSets, null, 4)},
    visibility = ["PUBLIC"],
)
`,
})
