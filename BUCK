load("//buck2:materialization.bzl", "export_materialization_inputs")

# Stable root entrypoint for the initial Buck2 foundation smoke target.
alias(
    name = "buck2_foundation",
    actual = "//buck2/evidence:synthetic_evidence",
)

# Exact root-package inputs for tui-core dependency materialization.
_TUI_CORE_MATERIALIZATION_INPUTS = [
    "context/effect/socket/package.json",
    "context/opentui/package.json",
    "package.json",
    "packages/@overeng/agent-session-ingest/package.json",
    "packages/@overeng/buck2-tools/package.json",
    "packages/@overeng/buck2-tools/src/buck2-materializer.ts",
    "packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts",
    "packages/@overeng/ci-tools/package.json",
    "packages/@overeng/content-address/package.json",
    "packages/@overeng/effect-ai-claude-cli/package.json",
    "packages/@overeng/effect-distributed-lock/package.json",
    "packages/@overeng/effect-path/package.json",
    "packages/@overeng/effect-react/package.json",
    "packages/@overeng/effect-rpc-tanstack/examples/basic/package.json",
    "packages/@overeng/effect-rpc-tanstack/package.json",
    "packages/@overeng/effect-schema-form-aria/package.json",
    "packages/@overeng/effect-schema-form/package.json",
    "packages/@overeng/genie/package.json",
    "packages/@overeng/kdl-effect/package.json",
    "packages/@overeng/kdl/package.json",
    "packages/@overeng/megarepo/package.json",
    "packages/@overeng/notion-cli/package.json",
    "packages/@overeng/notion-core/package.json",
    "packages/@overeng/notion-datasource-sync/package.json",
    "packages/@overeng/notion-effect-client/package.json",
    "packages/@overeng/notion-effect-schema/package.json",
    "packages/@overeng/notion-md/package.json",
    "packages/@overeng/notion-property-write/package.json",
    "packages/@overeng/notion-react/package.json",
    "packages/@overeng/npm-release/package.json",
    "packages/@overeng/otel-contract/package.json",
    "packages/@overeng/oxc-config/package.json",
    "packages/@overeng/pty-effect/package.json",
    "packages/@overeng/react-inspector/package.json",
    "packages/@overeng/restate-effect/package.json",
    "packages/@overeng/tui-react/package.json",
    "packages/@overeng/tui-stories/package.json",
    "packages/@overeng/utils-dev/package.json",
    "packages/@overeng/utils/package.json",
    "packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
]

export_materialization_inputs(_TUI_CORE_MATERIALIZATION_INPUTS)

# Hermetic TypeScript actions execute this source with their pinned Bun runtime.
export_file(
    name = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    src = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)
