"""Thin Prelude rust_binary to ProductExecutableInfo adapter."""

load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
load("@prelude//rust:cargo_buildscript.bzl", _prelude_buildscript_run = "buildscript_run")
load("@prelude//decls:rust_rules.bzl", _rust_test = "rust_test")
load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "cache_guarded_rule", "product_platform_constraints")
load("//buck2/provenance:defs.bzl", "product_artifact_info", "product_executable_info")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo", "host_capability_platform", "require_capability")
load(":toolchains.bzl", "RUST_COMPILER_WRAPPER_ENV")

def buildscript_run(name, env = None, **kwargs):
    """Runs Cargo build scripts with declared tools, not daemon-local PATH."""
    platform = host_capability_platform()
    shell = require_capability(CAPABILITIES, GENERATION, platform, "rust-shell")
    coreutils = require_capability(CAPABILITIES, GENERATION, platform, "action-env")
    action_env = dict(env or {})
    action_env.update(RUST_COMPILER_WRAPPER_ENV)
    # Bundled Prelude shims use /usr/bin/env bash and invoke dirname/realpath.
    # A task may start the daemon with only watchman on PATH; never inherit it.
    action_env["PATH"] = ":".join([
        shell["executableStorePath"].removesuffix("/bash"),
        coreutils["executableStorePath"].removesuffix("/coreutils"),
    ])
    _prelude_buildscript_run(name = name, env = action_env, **kwargs)

def _single_binary_output(dep):
    outputs = dep[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("rust_product_executable requires exactly one rust_binary default output")
    return outputs[0]

def _rust_product_executable_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    toolchain = ctx.attrs._rust_toolchain[ConfiguredRustToolchainInfo]
    expected = (
        str(ctx.attrs.target_platform.label.raw_target()),
        platform.os,
        platform.architecture,
        platform.abi,
        platform.runtime_contract,
        platform.rust_target_triple,
    )
    actual = (
        toolchain.target_platform_label,
        toolchain.target_platform_os,
        toolchain.target_platform_architecture,
        toolchain.target_platform_abi,
        toolchain.target_platform_runtime_contract,
        toolchain.target_triple,
    )
    if actual != expected:
        fail("rust_product_executable toolchain platform {} does not match target {}".format(actual, expected))
    executable = _single_binary_output(ctx.attrs.binary)
    product_executable = product_executable_info(
        ctx,
        executable = executable,
        recipe = ctx.attrs.recipe,
        toolchain = toolchain.identity,
        target_platform = platform,
    )
    return [
        DefaultInfo(default_output = executable),
        product_executable,
        product_artifact_info("executable", product_executable, platform, product_executable.provenance),
    ]

_rust_product_executable = cache_guarded_rule(
    impl = _rust_product_executable_impl,
    attrs = {
        "binary": attrs.dep(providers = [DefaultInfo]),
        "recipe": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "_rust_toolchain": attrs.default_only(attrs.toolchain_dep(
            default = "//buck2/toolchains:rust",
            providers = [ConfiguredRustToolchainInfo],
        )),
    },
)

def rust_product_executable(name, binary, recipe, target_platform, **kwargs):
    """Adapts one Prelude rust_binary for buck2/products:build_product."""
    if "target_compatible_with" in kwargs:
        fail("rust_product_executable owns target compatibility")
    _rust_product_executable(
        name = name,
        binary = binary,
        recipe = recipe,
        target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform),
        **kwargs
    )

def _cargo_build_script_impl(ctx):
    build_script = ctx.attrs.build_script[DefaultInfo].default_outputs
    if len(build_script) != 1:
        fail("cargo_build_script requires exactly one rust_binary default output")
    shell = ctx.attrs._shell[BuckSupportToolInfo]
    tree = ctx.actions.symlinked_dir("manifest_tree", ctx.attrs.srcs)
    package_dir = tree.project(ctx.attrs.package_path)
    launcher = ctx.actions.declare_output("launcher.sh")

    # Prelude buildscript_run points CARGO_MANIFEST_DIR at a fresh directory holding only
    # the manifest_dir entries, so `$CARGO_MANIFEST_DIR/..` escapes the package layout.
    # The launcher re-anchors the build script in the repository-relative tree, where
    # `$CARGO_MANIFEST_DIR/../<pkg>/<file>` reaches the declared inputs.
    ctx.actions.write(
        launcher,
        [
            "#!{}".format(shell.store_path),
            "set -eu",
            'here=$(cd -P -- "${0%/*}" && pwd)',
            # Prelude sets RUSTC relative to the directory it runs the script in; Cargo
            # promises a RUSTC runnable from the build script, so pin it before moving.
            'case "${RUSTC:-}" in "" | /*) ;; *) export RUSTC="$PWD/$RUSTC" ;; esac',
            cmd_args(
                cmd_args(package_dir, relative_to = (launcher, 1), quote = "shell"),
                format = 'cd -P -- "$here"/{}',
            ),
            'export CARGO_MANIFEST_DIR="$PWD"',
            # Set by the Nix-sandboxed prelude (nix/buck2-rules) to the loader that runs
            # portable-interpreter build scripts; unset on hosts, where they run directly.
            'loader="${BUCK2_RUST_BUILD_SCRIPT_LOADER:-}"',
            cmd_args(
                cmd_args(build_script[0], relative_to = (launcher, 1), quote = "shell"),
                format = 'exec $loader "$here"/{}',
            ),
            "",
        ],
        is_executable = True,
        allow_args = True,
    )
    return [
        # buildscript_run's manifest_dir: the package subtree.
        DefaultInfo(default_output = package_dir),
        # buildscript_run's buildscript: the launcher, carrying everything it execs or reads.
        RunInfo(args = cmd_args(launcher, hidden = [
            ctx.attrs.build_script[RunInfo],
            tree,
            shell.executable,
            shell.manifest,
        ])),
    ]

cargo_build_script = cache_guarded_rule(
    impl = _cargo_build_script_impl,
    attrs = {
        "build_script": attrs.exec_dep(providers = [RunInfo]),
        # Repository-relative paths: the package's own files and the inputs its build
        # script reads from other packages, so `$CARGO_MANIFEST_DIR/../<pkg>/<file>` resolves.
        "srcs": attrs.dict(key = attrs.string(), value = attrs.source()),
        "package_path": attrs.string(),
        "_shell": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:tool_rust_shell",
            providers = [BuckSupportToolInfo],
        )),
    },
    doc = "A first-party Cargo build script run with CARGO_MANIFEST_DIR in its repository-relative layout.",
)

def _rust_test_receipt_impl(ctx):
    verdict = ctx.actions.declare_output("tests.log")
    command = cmd_args(ctx.attrs.test[RunInfo], "--logfile", verdict.as_output())
    ctx.actions.run(command, category = "rust_test_receipt", local_only = True)
    return [
        DefaultInfo(default_output = verdict),
        ctx.attrs.test[RunInfo],
        ctx.attrs.test[ExternalRunnerTestInfo],
    ]

rust_test_receipt = cache_guarded_rule(
    impl = _rust_test_receipt_impl,
    attrs = {
        "test": attrs.exec_dep(providers = [RunInfo, ExternalRunnerTestInfo]),
    },
)

def _repository_path(path, label, allow_root = False):
    if allow_root and path == ".":
        return
    if not path or path.startswith("/") or "\\" in path or ":" in path:
        fail("{}: expected normalized repository-relative path, got {}".format(label, repr(path)))
    if any([part in ["", ".", ".."] for part in path.split("/")]):
        fail("{}: expected normalized repository-relative path, got {}".format(label, repr(path)))

def _cargo_resource_inventory_impl(ctx):
    label = str(ctx.label)
    keys = sorted(ctx.attrs.resources.keys())
    if sorted(ctx.attrs.destinations.keys()) != keys:
        fail("{}: resources and destinations must have identical keys".format(label))
    for key in ctx.attrs.expected_digests:
        if key not in ctx.attrs.resources:
            fail("{}: expected_digests contains unknown key {}".format(label, key))
    destinations = {}
    entries = []
    outputs = {}
    for key in keys:
        suffix = key[5:]
        if not key.startswith("file-") or not suffix or any([c not in "0123456789" for c in suffix.elems()]) or (len(suffix) > 1 and suffix.startswith("0")):
            fail("{}: malformed resource key {}".format(label, key))
        destination = ctx.attrs.destinations[key]
        _repository_path(destination, label)
        if destination in destinations:
            fail("{}: duplicate resource destination {}".format(label, destination))
        destinations[destination] = True
        digest = ctx.attrs.expected_digests.get(key)
        if digest != None and (len(digest) != 64 or any([c not in "0123456789abcdef" for c in digest.elems()])):
            fail("{}: invalid SHA256 for {}".format(label, key))
        entries.append({
            "key": key,
            "source": ctx.attrs.resources[key],
            "destination": destination,
            "expectedDigest": digest,
        })
        outputs[key] = ctx.actions.declare_output(key)
    for destination in destinations:
        parts = destination.split("/")
        for length in range(1, len(parts)):
            prefix = "/".join(parts[:length])
            if prefix in destinations:
                fail("{}: resource destination prefix collision: {} and {}".format(label, prefix, destination))
    manifest = ctx.actions.write_json("resources.json", entries, with_inputs = True)
    inventory = ctx.actions.declare_output("inventory.json")
    bun = ctx.attrs._bun[BuckSupportToolInfo]
    command = cmd_args(bun.executable, ctx.attrs._inventory_tool, manifest, inventory.as_output())
    for key in keys:
        command.add(key, outputs[key].as_output())
    command.add(cmd_args(hidden = [bun.manifest]))
    ctx.actions.run(command, category = "cargo_resource_inventory")
    return [DefaultInfo(
        default_output = inventory,
        sub_targets = {key: [DefaultInfo(default_output = output)] for key, output in outputs.items()},
    )]

cargo_resource_inventory = cache_guarded_rule(
    impl = _cargo_resource_inventory_impl,
    attrs = {
        "resources": attrs.dict(key = attrs.string(), value = attrs.source()),
        "destinations": attrs.dict(key = attrs.string(), value = attrs.string()),
        "expected_digests": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:tool_bun",
            providers = [BuckSupportToolInfo],
        )),
        "_inventory_tool": attrs.default_only(attrs.source(default = "//buck2/rust:cargo-resource-inventory.ts")),
    },
    doc = "Validates declared Cargo resource bytes and publishes verified files and their SHA256 inventory.",
)

def _cargo_rust_test_impl(ctx):
    _repository_path(ctx.attrs.cargo_package_path, str(ctx.label), allow_root = True)
    providers = _rust_test.impl(ctx)
    defaults = [p for p in providers if isinstance(p, DefaultInfo)]
    tests = [p for p in providers if isinstance(p, ExternalRunnerTestInfo)]
    if len(defaults) != 1 or len(tests) != 1:
        fail("Prelude rust_test must return one DefaultInfo and one ExternalRunnerTestInfo")
    default = defaults[0]
    test = tests[0]
    for field in ["test_type", "command", "env", "run_from_project_root", "use_project_relative_paths"]:
        if not hasattr(test, field):
            fail("Prelude rust_test provider is missing required field: " + field)
    if len(test.command) != 1 or not test.run_from_project_root or not test.use_project_relative_paths:
        fail("Prelude rust_test command/path contract changed")
    if "sources" not in default.sub_targets:
        fail("Prelude rust_test must expose its declared sources tree")
    source_outputs = default.sub_targets["sources"][DefaultInfo].default_outputs
    if len(source_outputs) != 1:
        fail("Prelude rust_test sources must have exactly one output")
    sources = source_outputs[0]
    shell = ctx.attrs._cargo_shell[BuckSupportToolInfo]
    manifest_dir = sources if ctx.attrs.cargo_package_path == "." else sources.project(ctx.attrs.cargo_package_path)
    env_file = ctx.actions.write_json(
        "cargo_test_env.json",
        {k: cmd_args(v, delimiter = " ") for k, v in test.env.items() if k != "CARGO_MANIFEST_DIR"},
        with_inputs = True,
        absolute = True,
    )
    runtime_command = cmd_args(
        ctx.attrs._inject_test_env[RunInfo],
        env_file,
        "--",
        test.command,
        absolute_prefix = "__CARGO_PROJECT_ROOT__",
        quote = "shell",
    )
    # allow_args returns the written artifact and macro files, not its runtime inputs.
    # ".." from the symlinked sources tree follows physical parents, not its lexical
    # Buck path. Anchor marked artifact arguments on the runtime project root before cd;
    # marking only artifacts preserves literal RunInfo arguments such as the injector's interpreter and flags.
    launcher, launcher_macros = ctx.actions.write(
        "cargo-test.sh",
        [
            "#!{}".format(shell.store_path),
            "set -eu",
            'root="$PWD"',
            'manifest="$1"; shift',
            cmd_args(
                "cargo_command=(",
                runtime_command,
                ")",
                delimiter = " ",
            ),
            'for index in "${!cargo_command[@]}"; do',
            '  cargo_command[index]="${cargo_command[index]//__CARGO_PROJECT_ROOT__/"$root"/}"',
            'done',
            # Inject after the shell: shells may discard env names containing '-'.
            'cd -P -- "$root/$manifest"',
            'export CARGO_MANIFEST_DIR="$PWD"',
            'exec "${cargo_command[@]}" "$@"',
            "",
        ],
        is_executable = True,
        allow_args = True,
    )
    command = cmd_args(launcher, manifest_dir, hidden = [
        sources,
        launcher_macros,
        runtime_command,
        shell.executable,
        shell.manifest,
    ])
    return [p for p in providers if not isinstance(p, ExternalRunnerTestInfo) and not isinstance(p, RunInfo)] + [
        RunInfo(args = command),
        ExternalRunnerTestInfo(**(
            {field: getattr(test, field) for field in dir(test) if field != "test_type"} |
            {"type": test.test_type, "command": [command]}
        )),
    ]

# Prelude fixes rust_test's cwd to the project root. Cargo instead runs in the
# manifest directory; use the *same declared tree* rustc uses for manifest paths.
# Runtime std::env::var("CARGO_MANIFEST_DIR") is supported; compile-time env! used
# for runtime paths is unsupported and must remain gated.
cargo_rust_test = cache_guarded_rule(
    impl = _cargo_rust_test_impl,
    attrs = _rust_test.attrs | {
        "cargo_package_path": attrs.string(default = "."),
        "_cargo_shell": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:tool_rust_shell",
            providers = [BuckSupportToolInfo],
        )),
    },
    uses_plugins = _rust_test.uses_plugins,
    supports_incoming_transition = _rust_test.supports_incoming_transition,
)
