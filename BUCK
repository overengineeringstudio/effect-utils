# Generated file - DO NOT EDIT
# Source: BUCK.genie.ts

# Projection source: BUCK.genie.ts
# Projection schema version: 1
# Projection generator: effect-utils/genie/buck2-root-aggregate-projection
# Semantic fingerprint: sha256:8862262d9f5166e14c5b9ebd8a066e40baade59d8c5659d2f64b250418b77bff
# Semantic inputs: BUCK.genie.ts, genie/buck2/mod.ts, genie/buck2/root-aggregate-projection.ts, genie/buck2/typescript-admissions.ts, context/effect/socket/BUCK.genie.ts, context/opentui/BUCK.genie.ts, packages/@overeng/agent-session-ingest/BUCK.genie.ts, packages/@overeng/buck2-tools/BUCK.genie.ts, packages/@overeng/ci-tools/BUCK.genie.ts, packages/@overeng/content-address/BUCK.genie.ts, packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts, packages/@overeng/effect-distributed-lock/BUCK.genie.ts, packages/@overeng/effect-path/BUCK.genie.ts, packages/@overeng/effect-react/BUCK.genie.ts, packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts, packages/@overeng/effect-rpc-tanstack/examples/basic/BUCK.genie.ts, packages/@overeng/effect-schema-form-aria/BUCK.genie.ts, packages/@overeng/effect-schema-form/BUCK.genie.ts, packages/@overeng/genie/BUCK.genie.ts, packages/@overeng/gh-ci-utils/BUCK.genie.ts, packages/@overeng/kdl-effect/BUCK.genie.ts, packages/@overeng/kdl/BUCK.genie.ts, packages/@overeng/megarepo/BUCK.genie.ts, packages/@overeng/notion-cli/BUCK.genie.ts, packages/@overeng/notion-core/BUCK.genie.ts, packages/@overeng/notion-datasource-sync/BUCK.genie.ts, packages/@overeng/notion-effect-client/BUCK.genie.ts, packages/@overeng/notion-effect-schema/BUCK.genie.ts, packages/@overeng/notion-md/BUCK.genie.ts, packages/@overeng/notion-property-write/BUCK.genie.ts, packages/@overeng/notion-react/BUCK.genie.ts, packages/@overeng/npm-release/BUCK.genie.ts, packages/@overeng/otel-contract/BUCK.genie.ts, packages/@overeng/oxc-config/BUCK.genie.ts, packages/@overeng/pty-effect/BUCK.genie.ts, packages/@overeng/react-inspector/BUCK.genie.ts, packages/@overeng/restate-effect/BUCK.genie.ts, packages/@overeng/stylex-tokens/BUCK.genie.ts, packages/@overeng/tui-core/BUCK.genie.ts, packages/@overeng/tui-react/BUCK.genie.ts, packages/@overeng/tui-stories/BUCK.genie.ts, packages/@overeng/utils-dev/BUCK.genie.ts, packages/@overeng/utils/BUCK.genie.ts
# Regenerate: devenv tasks run genie:run

load("//buck2:editor_view.bzl", "editor_view_inputs")
load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")
load("//buck2:static_checks.bzl", "STATIC_SOURCE_EXCLUDES", "STATIC_SOURCE_GLOBS", "static_source_set")

# Conventional prelude toolchain targets, owned by the platform hub.
#
# The composition root sets `[cell_aliases] toolchains = <platformHubCell>`
# (`composition/root/composition-root.ts`), so prelude's conventional
# `toolchains//:<lang>` spelling resolves into *this* package for every member cell in the
# composed workspace. Prelude rules used by any member therefore find exactly one instance
# of each conventional toolchain, and it is the hub's capability-backed one. Keeping them
# here preserves `05-composition/spec.md:51-56` ("the root carries no synthetic toolchains
# or `none` cell").
toolchain_alias(
    name = "rust",
    actual = "//buck2/toolchains:rust",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "cxx",
    actual = "//buck2/toolchains:cxx",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "go_bootstrap",
    actual = "//buck2/toolchains:go_bootstrap",
    visibility = ["PUBLIC"],
)

toolchain_alias(
    name = "python_bootstrap",
    actual = "//buck2/toolchains:python_bootstrap",
    visibility = ["PUBLIC"],
)

# Prelude's genrule toolchain carries no executable at all (`zip_scrubber = None`,
# `@prelude//:genrule_toolchain.bzl`), so there is nothing to pin and nothing to project:
# the upstream instance is already hermetic.
system_genrule_toolchain(
    name = "genrule",
    visibility = ["PUBLIC"],
)

export_file(
    name = "package.json",
    src = "package.json",
    visibility = ["PUBLIC"],
)

alias(
    name = "node_modules",
    actual = "//packages/@overeng/genie:node_modules",
    visibility = ["PUBLIC"],
)

alias(
    name = "editor_inputs",
    actual = ":node_modules",
    visibility = ["PUBLIC"],
)

alias(
    name = "root_editor_package_tree",
    actual = "//packages/@overeng/genie:package_tree",
    visibility = ["PUBLIC"],
)

editor_view_inputs(
    name = "editor_view_inputs",
    editor_inputs = ":editor_inputs",
    package_tree = ":root_editor_package_tree",
    visibility = ["PUBLIC"],
)
static_source_set(
    name = "static_sources",
    prefix = "",
    srcs = glob(
        [
            root + "/" + pattern
            for root in ["context", "packages", "scripts"]
            for pattern in STATIC_SOURCE_GLOBS
        ],
        exclude = [
            root + "/" + pattern
            for root in ["context", "packages", "scripts"]
            for pattern in STATIC_SOURCE_EXCLUDES
        ],
    ) + [
        ".oxfmtrc.json",
        ".oxlintrc.json",
        "devenv.lock",
        "devenv.yaml",
        "flake.lock",
        "flake.nix",
        "megarepo.kdl",
        "megarepo.lock",
        "tsconfig.lint.json",
    ],
    visibility = ["PUBLIC"],
)


# Workspace patches are declared inputs to the generated pnpm extraction actions.
export_file(
    name = "patches/@myobie__pty@0.10.0.patch",
    src = "patches/@myobie__pty@0.10.0.patch",
    visibility = ["PUBLIC"],
)

# Scoped repository checks derived from the TypeScript admission registry.
filegroup(
    name = "quick",
    srcs = {
        "000": "//context/effect/socket:typecheck",
        "001": "//context/opentui:typecheck",
        "002": "//packages/@overeng/agent-session-ingest:typecheck",
        "003": "//packages/@overeng/buck2-tools:typecheck",
        "004": "//packages/@overeng/ci-tools:typecheck",
        "005": "//packages/@overeng/content-address:typecheck",
        "006": "//packages/@overeng/effect-ai-claude-cli:typecheck",
        "007": "//packages/@overeng/effect-distributed-lock:typecheck",
        "008": "//packages/@overeng/effect-path:typecheck",
        "009": "//packages/@overeng/effect-react:typecheck",
        "010": "//packages/@overeng/effect-rpc-tanstack:typecheck",
        "011": "//packages/@overeng/effect-rpc-tanstack/examples/basic:typecheck",
        "012": "//packages/@overeng/effect-schema-form:typecheck",
        "013": "//packages/@overeng/effect-schema-form-aria:typecheck",
        "014": "//packages/@overeng/genie:typecheck",
        "015": "//packages/@overeng/gh-ci-utils:typecheck",
        "016": "//packages/@overeng/kdl:typecheck",
        "017": "//packages/@overeng/kdl-effect:typecheck",
        "018": "//packages/@overeng/megarepo:typecheck",
        "019": "//packages/@overeng/notion-cli:typecheck",
        "020": "//packages/@overeng/notion-core:typecheck",
        "021": "//packages/@overeng/notion-datasource-sync:typecheck",
        "022": "//packages/@overeng/notion-effect-client:typecheck",
        "023": "//packages/@overeng/notion-effect-schema:typecheck",
        "024": "//packages/@overeng/notion-md:typecheck",
        "025": "//packages/@overeng/notion-property-write:typecheck",
        "026": "//packages/@overeng/notion-react:typecheck",
        "027": "//packages/@overeng/npm-release:typecheck",
        "028": "//packages/@overeng/otel-contract:typecheck",
        "029": "//packages/@overeng/oxc-config:typecheck",
        "030": "//packages/@overeng/pty-effect:typecheck",
        "031": "//packages/@overeng/react-inspector:typecheck",
        "032": "//packages/@overeng/react-inspector:strict_consumer_typecheck",
        "033": "//packages/@overeng/restate-effect:typecheck",
        "034": "//packages/@overeng/stylex-tokens:typecheck",
        "035": "//packages/@overeng/tui-core:typecheck",
        "036": "//packages/@overeng/tui-react:typecheck",
        "037": "//packages/@overeng/tui-stories:typecheck",
        "038": "//packages/@overeng/utils:typecheck",
        "039": "//packages/@overeng/utils-dev:typecheck",
    },
    visibility = ["PUBLIC"],
)

filegroup(
    name = "all",
    srcs = {
        "000": ":quick",
        "001": "//packages/@overeng/agent-session-ingest:dist",
        "002": "//packages/@overeng/buck2-tools:dist",
        "003": "//packages/@overeng/ci-tools:dist",
        "004": "//packages/@overeng/content-address:dist",
        "005": "//packages/@overeng/effect-ai-claude-cli:dist",
        "006": "//packages/@overeng/effect-distributed-lock:dist",
        "007": "//packages/@overeng/effect-path:dist",
        "008": "//packages/@overeng/effect-react:dist",
        "009": "//packages/@overeng/effect-rpc-tanstack:dist",
        "010": "//packages/@overeng/effect-schema-form:dist",
        "011": "//packages/@overeng/effect-schema-form-aria:dist",
        "012": "//packages/@overeng/genie:dist",
        "013": "//packages/@overeng/gh-ci-utils:dist",
        "014": "//packages/@overeng/kdl:dist",
        "015": "//packages/@overeng/kdl-effect:dist",
        "016": "//packages/@overeng/megarepo:dist",
        "017": "//packages/@overeng/notion-cli:dist",
        "018": "//packages/@overeng/notion-core:dist",
        "019": "//packages/@overeng/notion-datasource-sync:dist",
        "020": "//packages/@overeng/notion-effect-client:dist",
        "021": "//packages/@overeng/notion-effect-schema:dist",
        "022": "//packages/@overeng/notion-md:dist",
        "023": "//packages/@overeng/notion-property-write:dist",
        "024": "//packages/@overeng/notion-react:dist",
        "025": "//packages/@overeng/npm-release:dist",
        "026": "//packages/@overeng/otel-contract:dist",
        "027": "//packages/@overeng/oxc-config:dist",
        "028": "//packages/@overeng/pty-effect:dist",
        "029": "//packages/@overeng/react-inspector:dist",
        "030": "//packages/@overeng/restate-effect:dist",
        "031": "//packages/@overeng/stylex-tokens:dist",
        "032": "//packages/@overeng/tui-core:dist",
        "033": "//packages/@overeng/tui-react:dist",
        "034": "//packages/@overeng/tui-stories:dist",
        "035": "//packages/@overeng/utils:dist",
        "036": "//packages/@overeng/utils-dev:dist",
        "037": "effect_utils//packages/@overeng/agent-session-ingest:test",
        "038": "effect_utils//packages/@overeng/ci-tools:test",
        "039": "effect_utils//packages/@overeng/content-address:test",
        "040": "effect_utils//packages/@overeng/effect-ai-claude-cli:test",
        "041": "effect_utils//packages/@overeng/effect-distributed-lock:test",
        "042": "effect_utils//packages/@overeng/effect-path:test",
        "043": "effect_utils//packages/@overeng/effect-react:test",
        "044": "effect_utils//packages/@overeng/effect-rpc-tanstack:test",
        "045": "effect_utils//packages/@overeng/effect-schema-form-aria:test",
        "046": "effect_utils//packages/@overeng/effect-schema-form:test",
        "047": "effect_utils//packages/@overeng/genie:test",
        "048": "effect_utils//packages/@overeng/gh-ci-utils:test",
        "049": "effect_utils//packages/@overeng/kdl-effect:test",
        "050": "effect_utils//packages/@overeng/kdl:test",
        "051": "effect_utils//packages/@overeng/megarepo:test",
        "052": "effect_utils//packages/@overeng/notion-cli:test",
        "053": "effect_utils//packages/@overeng/notion-core:test",
        "054": "effect_utils//packages/@overeng/notion-datasource-sync:test",
        "055": "effect_utils//packages/@overeng/notion-effect-client:test",
        "056": "effect_utils//packages/@overeng/notion-effect-schema:test",
        "057": "effect_utils//packages/@overeng/notion-md:test",
        "058": "effect_utils//packages/@overeng/notion-property-write:test",
        "059": "effect_utils//packages/@overeng/notion-react:test",
        "060": "effect_utils//packages/@overeng/npm-release:test",
        "061": "effect_utils//packages/@overeng/otel-contract:test",
        "062": "effect_utils//packages/@overeng/oxc-config:test",
        "063": "effect_utils//packages/@overeng/pty-effect:bundle_smoke",
        "064": "effect_utils//packages/@overeng/pty-effect:test",
        "065": "effect_utils//packages/@overeng/react-inspector:test",
        "066": "effect_utils//packages/@overeng/restate-effect:test",
        "067": "effect_utils//packages/@overeng/tui-core:test",
        "068": "effect_utils//packages/@overeng/tui-react:test",
        "069": "effect_utils//packages/@overeng/tui-stories:test",
        "070": "effect_utils//packages/@overeng/utils-dev:test",
        "071": "effect_utils//packages/@overeng/utils:test",
        "072": "//buck2/toolchains:archive_tool",
        "073": "//buck2/toolchains:product_tool",
    },
    visibility = ["PUBLIC"],
)
