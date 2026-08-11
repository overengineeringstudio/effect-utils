"""Hermetic wrapper for Reindeer-generated Cargo build-script actions."""

load("@prelude//rust:cargo_buildscript.bzl", _buildscript_run = "buildscript_run")

_NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz"

def configured_store_root(key):
    value = read_root_config("buck2_rust", key, "")
    parts = value.split("/")
    if (
        len(parts) != 4 or
        parts[0] != "" or
        parts[1] != "nix" or
        parts[2] != "store" or
        len(parts[3]) < 34 or
        parts[3][32] != "-" or
        "\n" in value or
        "\r" in value
    ):
        fail("buck2_rust.{} must be a canonical /nix/store/<hash>-<name> root".format(key))
    for character in parts[3][:32].elems():
        if character not in _NIX_BASE32:
            fail("buck2_rust.{} must contain a canonical Nix base32 store hash".format(key))
    for component in parts[3].split("-"):
        if not component or component == "." or component == "..":
            fail("buck2_rust.{} must be a canonical Nix store root".format(key))
    return value

def reindeer_buildscript_run(name, env = {}, **kwargs):
    """Run a Cargo build script with only validated Nix shell utilities on PATH."""
    buildscript_env = dict(env)
    buildscript_env["PATH"] = ":".join([
        configured_store_root("bash_root") + "/bin",
        configured_store_root("coreutils_root") + "/bin",
    ])
    _buildscript_run(
        name = name,
        env = buildscript_env,
        **kwargs
    )
