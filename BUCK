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
    srcs = [
        "//context/effect/socket:typecheck",
        "//context/opentui:typecheck",
        "//packages/@overeng/agent-session-ingest:typecheck",
        "//packages/@overeng/buck2-tools:typecheck",
        "//packages/@overeng/ci-tools:typecheck",
        "//packages/@overeng/content-address:typecheck",
        "//packages/@overeng/effect-ai-claude-cli:typecheck",
        "//packages/@overeng/effect-distributed-lock:typecheck",
        "//packages/@overeng/effect-path:typecheck",
        "//packages/@overeng/effect-react:typecheck",
        "//packages/@overeng/effect-rpc-tanstack:typecheck",
        "//packages/@overeng/effect-rpc-tanstack/examples/basic:typecheck",
        "//packages/@overeng/effect-schema-form:typecheck",
        "//packages/@overeng/effect-schema-form-aria:typecheck",
        "//packages/@overeng/genie:typecheck",
        "//packages/@overeng/gh-ci-utils:typecheck",
        "//packages/@overeng/kdl:typecheck",
        "//packages/@overeng/kdl-effect:typecheck",
        "//packages/@overeng/megarepo:typecheck",
        "//packages/@overeng/notion-cli:typecheck",
        "//packages/@overeng/notion-core:typecheck",
        "//packages/@overeng/notion-datasource-sync:typecheck",
        "//packages/@overeng/notion-effect-client:typecheck",
        "//packages/@overeng/notion-effect-schema:typecheck",
        "//packages/@overeng/notion-md:typecheck",
        "//packages/@overeng/notion-property-write:typecheck",
        "//packages/@overeng/notion-react:typecheck",
        "//packages/@overeng/npm-release:typecheck",
        "//packages/@overeng/otel-contract:typecheck",
        "//packages/@overeng/oxc-config:typecheck",
        "//packages/@overeng/pty-effect:typecheck",
        "//packages/@overeng/react-inspector:typecheck",
        "//packages/@overeng/react-inspector:strict_consumer_typecheck",
        "//packages/@overeng/restate-effect:typecheck",
        "//packages/@overeng/stylex-tokens:typecheck",
        "//packages/@overeng/tui-core:typecheck",
        "//packages/@overeng/tui-react:typecheck",
        "//packages/@overeng/tui-stories:typecheck",
        "//packages/@overeng/utils:typecheck",
        "//packages/@overeng/utils-dev:typecheck",
    ],
    visibility = ["PUBLIC"],
)

filegroup(
    name = "all",
    srcs = [
        ":quick",
        "//packages/@overeng/agent-session-ingest:dist",
        "//packages/@overeng/buck2-tools:dist",
        "//packages/@overeng/ci-tools:dist",
        "//packages/@overeng/content-address:dist",
        "//packages/@overeng/effect-ai-claude-cli:dist",
        "//packages/@overeng/effect-distributed-lock:dist",
        "//packages/@overeng/effect-path:dist",
        "//packages/@overeng/effect-react:dist",
        "//packages/@overeng/effect-rpc-tanstack:dist",
        "//packages/@overeng/effect-schema-form:dist",
        "//packages/@overeng/effect-schema-form-aria:dist",
        "//packages/@overeng/genie:dist",
        "//packages/@overeng/gh-ci-utils:dist",
        "//packages/@overeng/kdl:dist",
        "//packages/@overeng/kdl-effect:dist",
        "//packages/@overeng/megarepo:dist",
        "//packages/@overeng/notion-cli:dist",
        "//packages/@overeng/notion-core:dist",
        "//packages/@overeng/notion-datasource-sync:dist",
        "//packages/@overeng/notion-effect-client:dist",
        "//packages/@overeng/notion-effect-schema:dist",
        "//packages/@overeng/notion-md:dist",
        "//packages/@overeng/notion-property-write:dist",
        "//packages/@overeng/notion-react:dist",
        "//packages/@overeng/npm-release:dist",
        "//packages/@overeng/otel-contract:dist",
        "//packages/@overeng/oxc-config:dist",
        "//packages/@overeng/pty-effect:dist",
        "//packages/@overeng/react-inspector:dist",
        "//packages/@overeng/restate-effect:dist",
        "//packages/@overeng/stylex-tokens:dist",
        "//packages/@overeng/tui-core:dist",
        "//packages/@overeng/tui-react:dist",
        "//packages/@overeng/tui-stories:dist",
        "//packages/@overeng/utils:dist",
        "//packages/@overeng/utils-dev:dist",
        "effect_utils//packages/@overeng/agent-session-ingest:test",
        "effect_utils//packages/@overeng/ci-tools:test",
        "effect_utils//packages/@overeng/content-address:test",
        "effect_utils//packages/@overeng/effect-ai-claude-cli:test",
        "effect_utils//packages/@overeng/effect-distributed-lock:test",
        "effect_utils//packages/@overeng/effect-path:test",
        "effect_utils//packages/@overeng/effect-react:test",
        "effect_utils//packages/@overeng/effect-rpc-tanstack:test",
        "effect_utils//packages/@overeng/effect-schema-form-aria:test",
        "effect_utils//packages/@overeng/effect-schema-form:test",
        "effect_utils//packages/@overeng/genie:test",
        "effect_utils//packages/@overeng/gh-ci-utils:test",
        "effect_utils//packages/@overeng/kdl-effect:test",
        "effect_utils//packages/@overeng/kdl:test",
        "effect_utils//packages/@overeng/megarepo:test",
        "effect_utils//packages/@overeng/notion-cli:test",
        "effect_utils//packages/@overeng/notion-core:test",
        "effect_utils//packages/@overeng/notion-datasource-sync:test",
        "effect_utils//packages/@overeng/notion-effect-client:test",
        "effect_utils//packages/@overeng/notion-effect-schema:test",
        "effect_utils//packages/@overeng/notion-md:test",
        "effect_utils//packages/@overeng/notion-property-write:test",
        "effect_utils//packages/@overeng/notion-react:test",
        "effect_utils//packages/@overeng/npm-release:test",
        "effect_utils//packages/@overeng/otel-contract:test",
        "effect_utils//packages/@overeng/oxc-config:test",
        "effect_utils//packages/@overeng/pty-effect:bundle_smoke",
        "effect_utils//packages/@overeng/pty-effect:test",
        "effect_utils//packages/@overeng/react-inspector:test",
        "effect_utils//packages/@overeng/restate-effect:test",
        "effect_utils//packages/@overeng/tui-core:test",
        "effect_utils//packages/@overeng/tui-react:test",
        "effect_utils//packages/@overeng/tui-stories:test",
        "effect_utils//packages/@overeng/utils-dev:test",
        "effect_utils//packages/@overeng/utils:test",
        "//buck2/toolchains:archive_tool",
        "//buck2/toolchains:product_tool",
    ],
    visibility = ["PUBLIC"],
)
