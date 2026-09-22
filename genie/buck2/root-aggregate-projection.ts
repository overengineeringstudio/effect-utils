import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2SemanticFingerprint } from './mod.ts'
import {
  authoritativeBuck2TypeScriptDeclarations,
  authoritativeBuck2TypeScriptProjects,
  buck2TypeScriptTestTargets,
} from './typescript-admissions.ts'

const regenerationCommand = 'devenv tasks run genie:run' as const

export type RootBuckAggregatePlan = {
  readonly quick: readonly string[]
  readonly all: readonly string[]
}
const weaverTargets = [':weaver_check', ':weaver_version_smoke'] as const
const repositoryStaticTarget = '//buck2/static:check' as const
const fullAuthorityTargets = [
  '//buck2/toolchains:archive_tool',
  '//buck2/toolchains:product_tool',
] as const

export const planRootBuckAggregates = ({
  typecheckTargets = authoritativeBuck2TypeScriptProjects.map((project) => project.typecheckTarget),
  distTargets = authoritativeBuck2TypeScriptDeclarations.map(
    (declaration) => declaration.distTarget,
  ),
  testTargets = buck2TypeScriptTestTargets,
}: {
  readonly typecheckTargets?: readonly string[]
  readonly distTargets?: readonly string[]
  readonly testTargets?: readonly string[]
} = {}): RootBuckAggregatePlan => ({
  quick: [...typecheckTargets, ...weaverTargets, repositoryStaticTarget],
  all: [':quick', ...distTargets, ...testTargets, ...fullAuthorityTargets],
})

const renderAggregate = ({ name, targets }: { name: string; targets: readonly string[] }): string =>
  [
    'check_aggregate(',
    `    name = ${JSON.stringify(name)},`,
    '    targets = [',
    ...targets.map((target) => `        ${JSON.stringify(target)},`),
    '    ],',
    '    visibility = ["PUBLIC"],',
    ')',
  ].join('\n')

const rootBuckBase =
  'load("//buck2:editor_view.bzl", "editor_view_inputs")\nload("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")\nload("//buck2:static_checks.bzl", "STATIC_SOURCE_EXCLUDES", "STATIC_SOURCE_GLOBS", "static_source_set")\n\n# Conventional prelude toolchain targets, owned by the platform hub.\n#\n# The composition root sets `[cell_aliases] toolchains = <platformHubCell>`\n# (`composition/root/composition-root.ts`), so prelude\'s conventional\n# `toolchains//:<lang>` spelling resolves into *this* package for every member cell in the\n# composed workspace. Prelude rules used by any member therefore find exactly one instance\n# of each conventional toolchain, and it is the hub\'s capability-backed one. Keeping them\n# here preserves `05-composition/spec.md:51-56` ("the root carries no synthetic toolchains\n# or `none` cell").\ntoolchain_alias(\n    name = "rust",\n    actual = "//buck2/toolchains:rust",\n    visibility = ["PUBLIC"],\n)\n\ntoolchain_alias(\n    name = "cxx",\n    actual = "//buck2/toolchains:cxx",\n    visibility = ["PUBLIC"],\n)\n\ntoolchain_alias(\n    name = "go_bootstrap",\n    actual = "//buck2/toolchains:go_bootstrap",\n    visibility = ["PUBLIC"],\n)\n\ntoolchain_alias(\n    name = "python_bootstrap",\n    actual = "//buck2/toolchains:python_bootstrap",\n    visibility = ["PUBLIC"],\n)\n\n# Prelude\'s genrule toolchain carries no executable at all (`zip_scrubber = None`,\n# `@prelude//:genrule_toolchain.bzl`), so there is nothing to pin and nothing to project:\n# the upstream instance is already hermetic.\nsystem_genrule_toolchain(\n    name = "genrule",\n    visibility = ["PUBLIC"],\n)\n\nexport_file(\n    name = "package.json",\n    src = "package.json",\n    visibility = ["PUBLIC"],\n)\n\nalias(\n    name = "node_modules",\n    actual = "//packages/@overeng/genie:node_modules",\n    visibility = ["PUBLIC"],\n)\n\nalias(\n    name = "editor_inputs",\n    actual = ":node_modules",\n    visibility = ["PUBLIC"],\n)\n\nalias(\n    name = "root_editor_package_tree",\n    actual = "//packages/@overeng/genie:package_tree",\n    visibility = ["PUBLIC"],\n)\n\neditor_view_inputs(\n    name = "editor_view_inputs",\n    editor_inputs = ":editor_inputs",\n    package_tree = ":root_editor_package_tree",\n    visibility = ["PUBLIC"],\n)\nstatic_source_set(\n    name = "static_sources",\n    prefix = "",\n    srcs = glob(\n        [\n            root + "/" + pattern\n            for root in ["context", "packages", "scripts"]\n            for pattern in STATIC_SOURCE_GLOBS\n        ],\n        exclude = [\n            root + "/" + pattern\n            for root in ["context", "packages", "scripts"]\n            for pattern in STATIC_SOURCE_EXCLUDES\n        ],\n    ) + [\n        ".oxfmtrc.json",\n        ".oxlintrc.json",\n        "devenv.lock",\n        "devenv.yaml",\n        "flake.lock",\n        "flake.nix",\n        "megarepo.kdl",\n        "megarepo.lock",\n        "tsconfig.lint.json",\n    ],\n    visibility = ["PUBLIC"],\n)\n\n\n# Workspace patches are declared inputs to the generated pnpm extraction actions.\nexport_file(\n    name = "patches/@myobie__pty@0.10.0.patch",\n    src = "patches/@myobie__pty@0.10.0.patch",\n    visibility = ["PUBLIC"],\n)'


const rootValidationSources = `static_source_set(
    name = "nix_sources",
    prefix = "",
    srcs = glob(["**/*.nix"]),
    visibility = ["PUBLIC"],
)

static_source_set(
    name = "repository_validation_sources",
    prefix = "",
    srcs = glob([
        "*.genie.ts",
        ".github/**/*.ts",
        "genie/**/*.ts",
        "nix/**/*.json",
        "nix/**/*.nix",
        "nix/**/*.ts",
        "rust/*.lock",
        "rust/*.sh",
        "rust/*.toml",
    ]) + [
        "BUCK",
        "package.json",
        "pnpm-workspace.yaml",
        "rust-toolchain.toml",
    ],
    visibility = ["PUBLIC"],
)`
const aggregateRootBuckLoad = 'load("//buck2:check_aggregate.bzl", "check_aggregate")'

const weaverRootBuckLoad = 'load("//buck2:weaver.bzl", "weaver_checks")'
const weaverRootBuckTargets =
  'weaver_checks(\n    name = "weaver",\n    registry = {\n        "attributes.yaml": "genie/weaver-registry/attributes.yaml",\n        "manifest.yaml": "genie/weaver-registry/manifest.yaml",\n        "signals.yaml": "genie/weaver-registry/signals.yaml",\n    },\n    flake_nix = "nix/weaver-flake/flake.nix",\n    registry_source = "genie/weaver-registry/registry.ts",\n    visibility = ["PUBLIC"],\n)'

export const rootBuckAggregateProjection = (): GenieOutput<RootBuckAggregatePlan> => {
  const data = planRootBuckAggregates()
  const packageInputs = [
    ...new Set(
      authoritativeBuck2TypeScriptProjects.map((project) => `${project.packagePath}/BUCK.genie.ts`),
    ),
  ].toSorted()
  const semanticInputs = [
    'BUCK.genie.ts',
    'genie/buck2/mod.ts',
    'genie/buck2/root-aggregate-projection.ts',
    'genie/buck2/typescript-admissions.ts',
    'buck2/check_aggregate.bzl',
    'buck2/weaver.bzl',
    'packages/@overeng/buck2-tools/src/weaver-check-runner.ts',
    ...packageInputs,
  ]
  const fingerprint = buck2SemanticFingerprint({
    generator: 'effect-utils/genie/buck2-root-aggregate-projection',
    schemaVersion: 1,
    semanticData: data,
  })

  return createGenieOutput({
    data,
    stringify: () =>
      [
        '# Projection source: BUCK.genie.ts',
        '# Projection schema version: 1',
        '# Projection generator: effect-utils/genie/buck2-root-aggregate-projection',
        `# Semantic fingerprint: ${fingerprint}`,
        `# Semantic inputs: ${semanticInputs.join(', ')}`,
        `# Regenerate: ${regenerationCommand}`,
        weaverRootBuckLoad,
        aggregateRootBuckLoad,
        rootBuckBase,
        rootValidationSources,
        '',
        weaverRootBuckTargets,
        '',
        '# Scoped repository checks derived from the TypeScript admission registry.',
        renderAggregate({ name: 'quick', targets: data.quick }),
        '',
        '# Complete repository authority, including emitted declarations, tests, and archive/product toolchains.',
        renderAggregate({ name: 'all', targets: data.all }),
        '',
      ].join('\n'),
  })
}
