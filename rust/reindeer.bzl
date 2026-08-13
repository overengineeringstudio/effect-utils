"""Hermetic execution wrapper for reviewed Reindeer build scripts."""

load("@prelude//rust:cargo_buildscript.bzl", _buildscript_run = "buildscript_run")

def reindeer_buildscript_run(name, env = {}, **kwargs):
    configured = read_root_config("rust_toolchain", "tool_path", "")
    if not configured or not configured.startswith("/nix/store/") or ":/nix/store/" not in configured:
        fail("rust_toolchain.tool_path must contain exact Nix store tool roots")
    buildscript_env = dict(env)
    buildscript_env["PATH"] = configured
    _buildscript_run(name = name, env = buildscript_env, **kwargs)
