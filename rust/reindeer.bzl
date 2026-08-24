"""Hermetic execution wrapper for reviewed Reindeer build scripts."""

load("@prelude//rust:cargo_buildscript.bzl", _buildscript_run = "buildscript_run")

def reindeer_buildscript_run(name, env = {}, version = None, **kwargs):
    configured = read_root_config("rust_toolchain", "tool_path", "")
    if not configured or not configured.startswith("/nix/store/") or ":/nix/store/" not in configured:
        fail("rust_toolchain.tool_path must contain exact Nix store tool roots")
    buildscript_env = dict(env)
    buildscript_env["PATH"] = configured
    # Cargo always exposes the semver components of CARGO_PKG_VERSION to build
    # scripts; Prelude only forwards the combined variable. Re-derive them here
    # so crates like serde can read CARGO_PKG_VERSION_PATCH without per-crate
    # fixups.
    if version != None and version.count(".") == 2:
        major, minor, patch = version.split(".")
        buildscript_env.setdefault("CARGO_PKG_VERSION_MAJOR", major)
        buildscript_env.setdefault("CARGO_PKG_VERSION_MINOR", minor)
        buildscript_env.setdefault("CARGO_PKG_VERSION_PATCH", patch)
    _buildscript_run(name = name, env = buildscript_env, version = version, **kwargs)
