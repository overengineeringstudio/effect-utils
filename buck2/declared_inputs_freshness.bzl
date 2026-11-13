"""Offline equality verdicts over a consumer's exact generator input tree."""

load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_bun_command", "hermetic_cacheable_sandboxed_action", "hermetic_execution_constraints", "ts_action_attrs")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo", "EffectTsgoToolchainInfo")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:ts_sandbox.bzl", "TsSandboxToolchainInfo")

_RUNNER_PATH = "buck2/dependencies/declared-inputs-freshness.ts"


def _add_source(sources, path, source):
    if not path or path.startswith("/") or "\\" in path or any([part in ["", ".", ".."] for part in path.split("/")]):
        fail("declared input path must be a normalized tree-relative path: {}".format(path))
    if path in sources and sources[path] != source:
        fail("conflicting declared inputs at {}".format(path))
    sources[path] = source


def _declared_inputs_freshness_check_impl(ctx):
    bun = ctx.attrs._bun[BunToolchainInfo]
    tsgo = ctx.attrs._effect_tsgo[EffectTsgoToolchainInfo]
    sandbox = ctx.attrs._ts_sandbox[TsSandboxToolchainInfo]
    sources = {}
    _add_source(sources, ctx.attrs.lockfile_path, ctx.attrs.lockfile)
    _add_source(sources, ctx.attrs.sidecar_path, ctx.attrs.sidecar)
    for group in [ctx.attrs.workspace_manifests, ctx.attrs.patches, ctx.attrs.generator_sources, ctx.attrs.committed_outputs, ctx.attrs.runtime_sources]:
        for path, source in group.items():
            _add_source(sources, path, source)
    _add_source(sources, _RUNNER_PATH, ctx.attrs._runner)
    if ctx.attrs.generator not in ctx.attrs.generator_sources:
        fail("generator must name an entry in generator_sources")
    if ctx.attrs.generator.split("/")[-1] != "BUCK.genie.ts" or ctx.attrs.generator.removesuffix(".genie.ts") not in ctx.attrs.committed_outputs:
        fail("generator must name a BUCK.genie.ts with its BUCK in committed_outputs")
    if ctx.attrs.sidecar_path not in ctx.attrs.committed_outputs:
        fail("committed_outputs must include the sidecar at {}".format(ctx.attrs.sidecar_path))

    # External immutable-cell source artifacts can be absolute symlinks.
    # Follow only the declared artifact's root link (-H); preserve nested links
    # so staging cannot consume unkeyed referents outside a runtime tree.
    tool = ctx.attrs._action_env[BuckSupportToolInfo]
    source_tree = ctx.actions.declare_output("source", dir = True)
    staging = ["set -euo pipefail"]
    for path in sorted(sources.keys()):
        destination = source_tree.project(path)
        parent = "/".join(path.split("/")[:-1])
        staging.append(cmd_args([cmd_args(arg, quote = "shell") for arg in [
            tool.store_path, "--coreutils-prog=mkdir", "-p", "--",
            source_tree.project(parent) if parent else source_tree,
        ]], delimiter = " "))
        staging.append(cmd_args([cmd_args(arg, quote = "shell") for arg in [
            tool.store_path, "--coreutils-prog=cp", "--recursive", "-H",
            "--no-target-directory", "--", sources[path], destination,
        ]], delimiter = " "))
    stage_script = ctx.actions.write("stage-inputs.sh", staging, allow_args = True)
    hermetic_action(
        ctx,
        cmd_args([sandbox.shell, "--noprofile", "--norc", stage_script],
                 hidden = sources.values() + sandbox.inputs + [tool.executable, tool.manifest, source_tree.as_output()]),
        category = "declared_inputs_freshness_stage",
        identifier = ctx.attrs.name,
    )
    manifest = ctx.actions.write_json("freshness-manifest.json", {
        "lockfile": ctx.attrs.lockfile_path,
        "workspaceManifests": sorted(ctx.attrs.workspace_manifests.keys()),
        "patches": sorted(ctx.attrs.patches.keys()),
        "sidecar": ctx.attrs.sidecar_path,
        "generatorSources": sorted(ctx.attrs.generator_sources.keys()),
        "committedOutputs": sorted(ctx.attrs.committed_outputs.keys()),
        "generator": ctx.attrs.generator,
        "generatorExport": ctx.attrs.generator_export,
        "repairCommand": ctx.attrs.repair_command,
        "inputPaths": sorted(sources.keys()),
    })
    result = ctx.actions.declare_output("freshness", dir = True)
    inputs = [source_tree, manifest]
    command = cmd_args([
        hermetic_bun_command(ctx, bun.executable, sandbox_inputs = inputs),
        source_tree.project(_RUNNER_PATH),
        "--source", source_tree,
        "--manifest", manifest,
        "--output", result.as_output(),
    ])
    hermetic_cacheable_sandboxed_action(
        ctx,
        sandbox,
        {"bun": sandbox.closure_paths.get("bun", []), "effect-tsgo": tsgo.closure_paths},
        command,
        inputs,
        [result],
        tool_inputs = sandbox.bun_inputs + tsgo.inputs,
        category = "declared_inputs_freshness",
        identifier = ctx.attrs.name,
    )
    return [DefaultInfo(default_output = result)]


_declared_inputs_freshness_check = cache_guarded_rule(
    cache_eligible = lambda ctx: True,
    impl = _declared_inputs_freshness_check_impl,
    attrs = dict(ts_action_attrs(), **{
        "lockfile": attrs.source(),
        "lockfile_path": attrs.string(default = "pnpm-lock.yaml"),
        "workspace_manifests": attrs.dict(attrs.string(), attrs.source()),
        "patches": attrs.dict(attrs.string(), attrs.source(), default = {}),
        "sidecar": attrs.source(),
        "sidecar_path": attrs.string(default = "buck2/dependencies/pnpm-lock.sha256.json"),
        "generator_sources": attrs.dict(attrs.string(), attrs.source()),
        "committed_outputs": attrs.dict(attrs.string(), attrs.source()),
        "runtime_sources": attrs.dict(attrs.string(), attrs.source(), default = {}),
        "generator": attrs.string(default = "buck2/dependencies/BUCK.genie.ts"),
        "generator_export": attrs.string(default = "declaredInputsFreshness"),
        "repair_command": attrs.string(default = "devenv tasks run genie:run"),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "@rules//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_effect_tsgo": attrs.default_only(attrs.exec_dep(
            default = "@rules//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "@rules//buck2/dependencies:declared-inputs-freshness.ts",
        )),
    }),
)


def declared_inputs_freshness_check(name, exec_compatible_with = [], **kwargs):
    """Checks committed outputs using only declared, network-isolated inputs.

    Dictionary keys are consumer-root-relative destinations, not Buck package
    paths. Include the actual BUCK.genie.ts, its transitive imports and repository
    marker in generator_sources, and their installed dependencies in runtime_sources.
    Committed outputs (including the sidecar) are inputs, never action products.
    generator selects the module; generator_export selects its async entry
    (default declaredInputsFreshness), returning {buck: string, sidecar: string}.
    EFFECT_UTILS_PNPM_OFFLINE=1 is set before import; the entry must use its
    offline load path, including consumer workspace projection and validation.
    """
    _declared_inputs_freshness_check(
        name = name,
        exec_compatible_with = hermetic_execution_constraints(exec_compatible_with),
        **kwargs
    )
