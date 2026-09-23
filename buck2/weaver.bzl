"""Bounded Weaver registry checks over declared sources and Nix capabilities."""

load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")


def _run_weaver(ctx, mode, inputs):
    toolchain = ctx.attrs._javascript[EffectTsgoToolchainInfo]
    weaver = ctx.attrs._weaver[BuckSupportToolInfo]
    semconv_model = ctx.attrs._semconv_model[BuckSupportToolInfo]
    result = ctx.actions.declare_output("{}.json".format(ctx.attrs.name))
    args = cmd_args([
        toolchain.bun,
        ctx.attrs._runner,
        "--mode",
        mode,
        "--weaver",
        weaver.executable,
        "--semconv-model",
        semconv_model.executable,
        "--output",
        result.as_output(),
    ])
    for flag, source in inputs:
        args.add(flag, source)
    args.add(cmd_args(hidden = [weaver.manifest, semconv_model.manifest]))
    ctx.actions.run(
        args,
        category = "weaver_{}".format(mode.replace("-", "_")),
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
    )
    return [DefaultInfo(default_output = result)]


def _weaver_check_impl(ctx):
    registry = ctx.actions.copied_dir("registry", ctx.attrs.registry)
    return _run_weaver(ctx, "check", [("--registry", registry)])


def _weaver_version_smoke_impl(ctx):
    return _run_weaver(ctx, "version-smoke", [
        ("--flake-nix", ctx.attrs.flake_nix),
        ("--registry-source", ctx.attrs.registry_source),
    ])


_common_attrs = {
    "_javascript": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:effect_tsgo",
        providers = [EffectTsgoToolchainInfo],
    )),
    "_runner": attrs.default_only(attrs.source(
        default = "//packages/@overeng/buck2-tools:src/weaver-check-runner.ts",
    )),
    "_weaver": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:tool_weaver",
        providers = [BuckSupportToolInfo],
    )),
    "_semconv_model": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:tool_semconv_model",
        providers = [BuckSupportToolInfo],
    )),
}

_weaver_check = rule(
    impl = _weaver_check_impl,
    attrs = dict(_common_attrs, registry = attrs.dict(key = attrs.string(), value = attrs.source())),
)

_weaver_version_smoke = rule(
    impl = _weaver_version_smoke_impl,
    attrs = dict(
        _common_attrs,
        flake_nix = attrs.source(),
        registry_source = attrs.source(),
    ),
)


def weaver_checks(name, registry, flake_nix, registry_source, **kwargs):
    """Declares registry conformance and version-pin checks."""
    _weaver_check(name = name + "_check", registry = registry, **kwargs)
    _weaver_version_smoke(
        name = name + "_version_smoke",
        flake_nix = flake_nix,
        registry_source = registry_source,
        **kwargs
    )
