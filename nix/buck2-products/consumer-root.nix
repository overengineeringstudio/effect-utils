{
  pkgs,
  rules,
  capabilities,
  cellName,
  projectIgnore ? [
    "**/__pycache__"
    "**/dist"
    "**/node_modules"
    "**/target"
    ".devenv"
    ".git"
    "buck-out"
    "node_modules"
    "target"
    "tmp"
  ],
}:

let
  lib = pkgs.lib;
  ignore = lib.concatStringsSep "," projectIgnore;
  buckConfig = ''
    [cells]
      ${cellName} = .
      rules = .buck2/rules
      capabilities = .buck2/capabilities
      prelude = .buck2/rules/prelude

    [cell_aliases]
      config = prelude
      ovr_config = prelude
      fbsource = prelude
      toolchains = ${cellName}

    [parser]
      target_platform_detector_spec = target:${cellName}//...->rules//buck2/platforms:host_platform

    [build]
      execution_platforms = rules//buck2/platforms:host_execution_platform

    [buck2]
      file_watcher = notify
      digest_algorithms = SHA256
      remote_cache_enabled = false
      allow_cache_uploads = false

    [project]
      ignore = ${ignore}
  '';
  rootBuck = ''
    load("@prelude//toolchains:genrule.bzl", "system_genrule_toolchain")
    toolchain_alias(name = "rust", actual = "//buck2/toolchains:rust", visibility = ["PUBLIC"])
    toolchain_alias(name = "cxx", actual = "//buck2/toolchains:cxx", visibility = ["PUBLIC"])
    toolchain_alias(name = "go_bootstrap", actual = "//buck2/toolchains:go_bootstrap", visibility = ["PUBLIC"])
    toolchain_alias(name = "python_bootstrap", actual = "//buck2/toolchains:python_bootstrap", visibility = ["PUBLIC"])
    system_genrule_toolchain(name = "genrule", visibility = ["PUBLIC"])
    alias(name = "package_tree_runtime", actual = "@rules//:package_tree_runtime", visibility = ["PUBLIC"])
    alias(name = "package_command_runtime", actual = "@rules//:package_command_runtime", visibility = ["PUBLIC"])
  '';
  toolchainsBuck = ''
    load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
    load("@rules//buck2/platforms:defs.bzl", "host_platform_label")
    load("@rules//buck2/rust:toolchains.bzl", "native_rust_toolchains")
    load("@rules//buck2/toolchains:configured.bzl", "support_tool")
    load("@rules//buck2/toolchains:defs.bzl", "bun_toolchain", "effect_tsgo_toolchain", "nix_go_bootstrap_toolchain", "nix_python_bootstrap_toolchain")

    support_tool(name = "archive_tool", protocol = "effect-utils/buck2-archive-tool/v2", tool_id = "archive-tool", visibility = ["PUBLIC"])
    support_tool(name = "product_tool", protocol = "effect-utils/buck2-product/v1", tool_id = "product", visibility = ["PUBLIC"])
    support_tool(name = "tool_coreutils_readlink", protocol = "gnu/coreutils/v9", tool_id = "coreutils-readlink", visibility = ["PUBLIC"])
    native_rust_toolchains(capabilities = CAPABILITIES, generation = GENERATION, target_platform = "@rules" + host_platform_label())
    nix_python_bootstrap_toolchain(name = "python_bootstrap", capabilities = CAPABILITIES, generation = GENERATION, visibility = ["PUBLIC"])
    nix_go_bootstrap_toolchain(name = "go_bootstrap", capabilities = CAPABILITIES, generation = GENERATION, visibility = ["PUBLIC"])
    bun_toolchain(name = "bun", capabilities = CAPABILITIES, generation = GENERATION, visibility = ["PUBLIC"])
    effect_tsgo_toolchain(
        name = "effect_tsgo",
        capabilities = CAPABILITIES,
        generation = GENERATION,
        runner = "@rules//:packages/@overeng/buck2-tools/src/typescript-runner.ts",
        visibility = ["PUBLIC"],
    )
  '';
in
assert lib.assertMsg (
  builtins.isString cellName
  && builtins.match "[A-Za-z][A-Za-z0-9_]*" cellName != null
  && !(builtins.elem cellName [
    "capabilities"
    "effect_utils"
    "prelude"
    "rules"
  ])
) "mkConsumerBuckRoot: cellName must be a non-reserved Buck cell identifier";
pkgs.runCommand "${cellName}-buck2-root"
  {
    passthru = {
      inherit
        buckConfig
        capabilities
        cellName
        rules
        rootBuck
        toolchainsBuck
        ;
    };
  }
  ''
    mkdir -p "$out/.buck2/rules" "$out/.buck2/capabilities" "$out/buck2/toolchains"
    cp -R ${rules}/. "$out/.buck2/rules/"
    cp -R ${capabilities}/. "$out/.buck2/capabilities/"
    cat > "$out/.buckconfig" <<'BUCKCONFIG'
    ${buckConfig}
    BUCKCONFIG
    : > "$out/.buckroot"
    cat > "$out/BUCK" <<'ROOT_BUCK'
    ${rootBuck}
    ROOT_BUCK
    cat > "$out/buck2/toolchains/BUCK" <<'TOOLCHAINS_BUCK'
    ${toolchainsBuck}
    TOOLCHAINS_BUCK
  ''
