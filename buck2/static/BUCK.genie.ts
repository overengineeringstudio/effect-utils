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
  ...pnpmWorkspaceMemberPaths.map(
    (packagePath) => `//${packagePath}:repository_validation_sources`,
  ),
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
load("//buck2:quick_contracts.bzl", "quick_contracts")
load("//buck2:byte_parity.bzl", "byte_parity")

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

byte_parity(
    name = "work_storage_resources_check",
    pairs = {
        "packages/@overeng/work-storage/protocol.schema.json": "rust/work-storage/resources/protocol.schema.json",
        "packages/@overeng/work-storage/fixtures/conformance.json": "rust/work-storage/resources/conformance.json",
    },
    source_sets = [
        "//packages/@overeng/work-storage:static_sources",
        "//rust/work-storage:static_sources",
    ],
    visibility = ["PUBLIC"],
)

quick_contracts(
    name = "check_quick",
    quick = "//:quick",
    runtime = "//buck2/toolchains:quick_contracts",
    source_sets = ${JSON.stringify([...new Set([...sourceSets, ...nixSourceSets, ...repositorySourceSets])].toSorted(), null, 4)},
    visibility = ["PUBLIC"],
)
`,
})
