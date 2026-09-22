"""Repository-wide static checks over exact package-local source manifests."""

load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

STATIC_SOURCE_GLOBS = [
    "**/*.cjs",
    "**/*.cts",
    "**/*.css",
    "**/*.gql",
    "**/*.graphql",
    "**/*.handlebars",
    "**/*.hbs",
    "**/*.html",
    "**/*.js",
    "**/*.json",
    "**/*.json5",
    "**/*.jsonc",
    "**/*.jsx",
    "**/*.less",
    "**/*.markdown",
    "**/*.md",
    "**/*.mdx",
    "**/*.mjs",
    "**/*.mts",
    "**/*.sass",
    "**/*.scss",
    "**/*.toml",
    "**/*.ts",
    "**/*.tsx",
    "**/*.vue",
    "**/*.yaml",
    "**/*.yml",
]
STATIC_SOURCE_EXCLUDES = [
    "**/dist/**",
    "**/node_modules/**",
    "**/storybook-static/**",
    "**/tmp/**",
]

StaticSourceSetInfo = provider(fields = {
    "files": provider_field(list[Artifact]),
    "node_modules": provider_field(list[Artifact]),
    "prefix": str,
})


def _static_source_set_impl(ctx):
    node_modules = [] if ctx.attrs.node_modules == None else ctx.attrs.node_modules[DefaultInfo].default_outputs
    if len(node_modules) > 1:
        fail("static source set node_modules dependency must expose exactly one tree")
    return [
        DefaultInfo(),
        StaticSourceSetInfo(files = ctx.attrs.srcs, node_modules = node_modules, prefix = ctx.attrs.prefix),
    ]


_static_source_set = rule(
    impl = _static_source_set_impl,
    attrs = {
        "prefix": attrs.string(),
        "node_modules": attrs.option(attrs.dep(), default = None),
        "srcs": attrs.list(attrs.source()),
    },
)


def static_source_set(name, prefix, srcs, node_modules = None, **kwargs):
    """Declares one package boundary's governed static source files and dependency view."""
    _static_source_set(name = name, node_modules = node_modules, prefix = prefix, srcs = srcs, **kwargs)

def _collect_static_sources(ctx, output, include_node_modules):
    sources = {}
    for source_set_target in ctx.attrs.source_sets:
        source_set = source_set_target[StaticSourceSetInfo]
        for source in source_set.files:
            destination = source.short_path if not source_set.prefix else source_set.prefix + "/" + source.short_path
            if destination in sources:
                fail("duplicate static source destination: {}".format(destination))
            sources[destination] = source
        if include_node_modules:
            for node_modules in source_set.node_modules:
                destination = source_set.prefix + "/node_modules"
                if destination in sources:
                    fail("duplicate static dependency destination: {}".format(destination))
                sources[destination] = node_modules
    return sources, ctx.actions.copied_dir(output, sources)


def _repository_static_check_impl(ctx):
    tool = ctx.attrs.tool[BuckSupportToolInfo]
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sources, source_tree = _collect_static_sources(ctx, "source", True)
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    args = cmd_args([
        toolchain.bun,
        ctx.attrs._runner,
        "--kind",
        ctx.attrs.kind,
        "--source",
        source_tree,
        "--tool",
        tool.executable,
        "--output",
        result.as_output(),
    ])
    for source_path in sorted(sources.keys()):
        args.add("--path", source_path)
    args.add(cmd_args(hidden = [source_tree, tool.manifest]))
    ctx.actions.run(
        args,
        category = "{}_check".format(ctx.attrs.kind),
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


_repository_static_check = rule(
    impl = _repository_static_check_impl,
    attrs = {
        "kind": attrs.enum(["format", "lint"]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "tool": attrs.exec_dep(providers = [BuckSupportToolInfo]),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/static-check-runner.ts",
        )),
    },
)


def _repository_policy_check_impl(ctx):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sources, source_tree = _collect_static_sources(ctx, "policy_source", False)
    manifest = ctx.actions.declare_output("policy_manifest.json")
    ctx.actions.write_json(manifest, {
        "declaredPackages": sorted(ctx.attrs.declared_packages),
        "sourcePaths": sorted(sources.keys()),
    })
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    ctx.actions.run(
        cmd_args([
            toolchain.bun,
            ctx.attrs._runner,
            "--manifest",
            manifest,
            "--source",
            source_tree,
            "--output",
            result.as_output(),
        ], hidden = [source_tree]),
        category = "repository_policy_check",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


_repository_policy_check = rule(
    impl = _repository_policy_check_impl,
    attrs = {
        "declared_packages": attrs.list(attrs.string()),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/repository-policy-runner.ts",
        )),
    },
)

def _single_default_output(target, field):
    outputs = target[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("{} must expose exactly one default output".format(field))
    return outputs[0]


def _repository_validation_check_impl(ctx):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    sources, source_tree = _collect_static_sources(ctx, "validation_source", False)
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    hidden = [source_tree]
    manifest = None
    if ctx.attrs.declared_packages:
        manifest = ctx.actions.declare_output("workspace_manifest.json")
        ctx.actions.write_json(manifest, {
            "declaredPackages": sorted(ctx.attrs.declared_packages),
        })
        hidden.append(manifest)

    if ctx.attrs.script != None:
        if manifest == None:
            fail("script-backed repository validation requires declared_packages")
        shell = ctx.attrs.tools["shell"][BuckSupportToolInfo]
        args = cmd_args([
            shell.executable,
            ctx.attrs.script,
            source_tree,
            toolchain.bun,
            cmd_args(
                source_tree,
                format = "{}/packages/@overeng/buck2-tools/src/repository-validation-runner.ts",
            ),
            result.as_output(),
            manifest,
        ])
        hidden.extend([shell.manifest, ctx.attrs.script])
        for name in sorted(ctx.attrs.tools.keys()):
            if name == "shell":
                continue
            tool = ctx.attrs.tools[name][BuckSupportToolInfo]
            args.add("--tool", cmd_args(tool.executable, format = name + "={}"))
            hidden.append(tool.manifest)
    else:
        args = cmd_args([
            toolchain.bun,
            ctx.attrs._runner,
            "--mode",
            ctx.attrs.mode,
            "--source",
            source_tree,
            "--output",
            result.as_output(),
        ])
        for source_path in sorted(sources.keys()):
            args.add("--path", source_path)
        for name in sorted(ctx.attrs.tools.keys()):
            tool = ctx.attrs.tools[name][BuckSupportToolInfo]
            args.add("--tool", cmd_args(tool.executable, format = name + "={}"))
            hidden.append(tool.manifest)
        if ctx.attrs.checker != None:
            checker = _single_default_output(ctx.attrs.checker, "checker")
            args.add("--checker", checker)
            hidden.append(checker)
        if ctx.attrs.server != None:
            server = _single_default_output(ctx.attrs.server, "server")
            args.add("--server", server)
            hidden.append(server)
        if manifest != None:
            args.add("--manifest", manifest)
    args.add(cmd_args(hidden = hidden))
    ctx.actions.run(
        args,
        category = "repository_validation",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


_repository_validation_check = rule(
    impl = _repository_validation_check_impl,
    attrs = {
        "checker": attrs.option(attrs.dep(), default = None),
        "declared_packages": attrs.list(attrs.string(), default = []),
        "mode": attrs.enum([
            "devenv-trace-audit",
            "genie-import-closure",
            "nix-source",
            "workspace-contract",
        ]),
        "server": attrs.option(attrs.dep(), default = None),
        "script": attrs.option(attrs.source(), default = None),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "tools": attrs.dict(
            key = attrs.string(),
            value = attrs.exec_dep(providers = [BuckSupportToolInfo]),
            default = {},
        ),
        "_javascript": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.source(
            default = "//packages/@overeng/buck2-tools:src/repository-validation-runner.ts",
        )),
    },
)


def repository_static_checks(
        name,
        declared_packages,
        source_sets,
        nix_source_sets,
        repository_source_sets,
        **kwargs):
    """Checks repository formatting, lint, source policy, and deterministic validation contracts."""
    _repository_static_check(
        name = name + "_format",
        kind = "format",
        source_sets = source_sets,
        tool = "//buck2/toolchains:tool_oxfmt",
        **kwargs
    )
    _repository_static_check(
        name = name + "_lint",
        kind = "lint",
        source_sets = source_sets,
        tool = "//buck2/toolchains:tool_oxlint",
        **kwargs
    )
    _repository_policy_check(
        name = name + "_policy",
        declared_packages = declared_packages,
        source_sets = source_sets,
        **kwargs
    )
    _repository_validation_check(
        name = "nix_source_check",
        mode = "nix-source",
        source_sets = nix_source_sets,
        tools = {
            "deadnix": "//buck2/toolchains:tool_deadnix",
            "nixfmt": "//buck2/toolchains:tool_nixfmt",
        },
        **kwargs
    )
    _repository_validation_check(
        name = "genie_import_closure_check",
        checker = "//packages/@overeng/genie:genie-bootstrap-closure-check-candidate",
        mode = "genie-import-closure",
        server = "//packages/@overeng/genie:typescript-api-server-product-executable",
        source_sets = repository_source_sets,
        **kwargs
    )
    _repository_validation_check(
        name = "devenv_trace_audit_check",
        mode = "devenv-trace-audit",
        source_sets = repository_source_sets,
        **kwargs
    )
    _repository_validation_check(
        name = "workspace_contract_check",
        declared_packages = declared_packages,
        mode = "workspace-contract",
        source_sets = repository_source_sets,
        script = "//:rust/workspace-contract.test.sh",
        tools = {
            "cargo": "//buck2/toolchains:tool_cargo",
            "nix": "//buck2/toolchains:tool_nix",
            "shell": "//buck2/toolchains:tool_rust_shell",
        },
        **kwargs
    )
    native.filegroup(
        name = name,
        srcs = [
            ":" + name + "_format",
            ":" + name + "_lint",
            ":" + name + "_policy",
            ":nix_source_check",
            ":genie_import_closure_check",
            ":devenv_trace_audit_check",
            ":workspace_contract_check",
        ],
        **kwargs
    )
