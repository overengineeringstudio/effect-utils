{
  pkgs,
  buck2,
  src,
  pnpmArchives,
}:

let
  lib = pkgs.lib;
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  files = inventory.files;
  sortedFiles = builtins.sort builtins.lessThan files;
  patchFiles = builtins.filter (path: lib.hasSuffix ".patch" path) files;
in
assert lib.assertMsg (
  builtins.attrNames inventory == [
    "files"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck2-rules-inventory/v1"
  && inventory.schemaVersion == 1
) "buck2-rules: generated inventory schema is invalid";
assert lib.assertMsg (files == sortedFiles) "buck2-rules: generated inventory must be sorted";
assert lib.assertMsg (
  builtins.length files == builtins.length (lib.unique files)
) "buck2-rules: generated inventory paths must be unique";
pkgs.runCommand "buck2-rules"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
    ];
    passthru = {
      inherit inventory;
      prelude = buck2.passthru.prelude;
    };
  }
  ''
    mkdir -p "$out"
    ${lib.concatMapStringsSep "\n" (path: ''
      mkdir -p "$out/${builtins.dirOf path}"
      cp ${lib.escapeShellArg "${src}/${path}"} "$out/${lib.escapeShellArg path}"
    '') files}
    # The published rules cell has no pnpm store view: stage the two pinned,
    # pure-JavaScript parser packages as a self-contained runner source tree.
    for package in acorn acorn-walk; do
      mkdir -p "$out/packages/@overeng/buck2-tools/node_modules/$package"
    done
    tar -xzf ${pnpmArchives.passthru.archivesByIdentity."acorn@8.18.0"} \
      --strip-components=1 -C "$out/packages/@overeng/buck2-tools/node_modules/acorn"
    tar -xzf ${pnpmArchives.passthru.archivesByIdentity."acorn-walk@8.3.5"} \
      --strip-components=1 -C "$out/packages/@overeng/buck2-tools/node_modules/acorn-walk"
    cp ${./inventory.json} "$out/inventory.json"
    cat > "$out/BUCK" <<'BUCK'
    alias(
        name = "package_tree_runtime",
        actual = "//packages/@overeng/buck2-tools:package_tree_runtime",
        visibility = ["PUBLIC"],
    )

    alias(
        name = "package_command_runtime",
        actual = "//packages/@overeng/buck2-tools:package_command_runtime",
        visibility = ["PUBLIC"],
    )
    BUCK
    # Publish only patch files, not their checkout's package BUCK declarations:
    # those declarations depend on the standalone cell and its toolchains.
    ${lib.concatMapStringsSep "\n" (
      path:
      let
        parts = lib.splitString "/patches/" path;
        package = builtins.head parts;
        source = "patches/${lib.concatStringsSep "/patches/" (builtins.tail parts)}";
      in
      ''
        cat >> "$out/${package}/BUCK" <<'PATCH_BUCK'
        export_file(
            name = ${builtins.toJSON source},
            src = ${builtins.toJSON source},
            visibility = ["PUBLIC"],
        )
        PATCH_BUCK
      ''
    ) patchFiles}
    cat > "$out/buck2/dependencies/BUCK" <<'BUCK'
    export_file(
        name = "acquire-archive.ts",
        src = "acquire-archive.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "assemble-store.ts",
        src = "assemble-store.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "nix-archive.ts",
        src = "nix-archive.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "public-archive-origin.ts",
        src = "public-archive-origin.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "runtime-closure.ts",
        src = "runtime-closure.ts",
        visibility = ["PUBLIC"],
    )
    BUCK
    mkdir -p "$out/packages/@overeng/buck2-tools"
    cat > "$out/packages/@overeng/buck2-tools/BUCK" <<'BUCK'
    load("//buck2/package_tools.bzl", "package_command_runtime")

    filegroup(
        name = "package_tree_runtime",
        srcs = {
            "package-tree.ts": "src/package-tree.ts",
            "real-path.ts": "src/real-path.ts",
        },
        visibility = ["PUBLIC"],
    )

    filegroup(
        name = "package_command_runtime_files",
        srcs = {
            "package-command-runner.ts": "src/package-command-runner.ts",
            "real-path.ts": "src/real-path.ts",
            "typescript-runner.ts": "src/typescript-runner.ts",
            "node_modules/acorn/package.json": "node_modules/acorn/package.json",
            "node_modules/acorn/dist/acorn.mjs": "node_modules/acorn/dist/acorn.mjs",
            "node_modules/acorn-walk/package.json": "node_modules/acorn-walk/package.json",
            "node_modules/acorn-walk/dist/walk.mjs": "node_modules/acorn-walk/dist/walk.mjs",
        },
        visibility = ["PUBLIC"],
    )

    package_command_runtime(
        name = "package_command_runtime",
        files = ":package_command_runtime_files",
        vendored_files = ":package_command_runtime_files",
        visibility = ["PUBLIC"],
    )

    filegroup(
        name = "javascript_action_runtime",
        srcs = {
            "javascript-runner.ts": "src/javascript-runner.ts",
            "typescript-runner.ts": "src/typescript-runner.ts",
        },
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "typescript-runner.ts",
        src = "src/typescript-runner.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "src/static-check-runner.ts",
        src = "src/static-check-runner.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "src/repository-policy-runner.ts",
        src = "src/repository-policy-runner.ts",
        visibility = ["PUBLIC"],
    )

    export_file(
        name = "src/repository-validation-runner.ts",
        src = "src/repository-validation-runner.ts",
        visibility = ["PUBLIC"],
    )
    BUCK
    chmod -R u+w "$out"
    mkdir -p "$out/prelude"
    tar -xzf ${buck2.passthru.prelude} --strip-components=1 -C "$out/prelude"
    # Prelude-generated linker and Cargo buildscript shims run in Nix sandboxes,
    # where /usr/bin/env does not exist. Bind their interpreter to the declared
    # shell rather than relying on the host filesystem.
    for script in \
      "$out/prelude/utils/cmd_script.bzl" \
      "$out/prelude/rust/cargo_buildscript.bzl" \
      "$out/prelude/rust/context.bzl"; do
      substituteInPlace "$script" \
        --replace-fail '"#!/usr/bin/env bash"' '"#!${pkgs.bash}/bin/bash"'
    done
    ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
      # Product binaries intentionally use the portable /lib64 interpreter.
      # A Cargo build script is an executable build-time tool, however, and
      # cannot use that interpreter inside the Nix sandbox. Run ELF build
      # scripts through the declared loader and libraries without changing the
      # product's ELF. A first-party `cargo_build_script` launcher
      # (buck2/rust/defs.bzl) is a shell script: it receives the loader as
      # BUCK2_RUST_BUILD_SCRIPT_LOADER and applies it to the build script it execs.
      substituteInPlace "$out/prelude/rust/tools/buildscript_run.py" \
        --replace-fail 'def run_buildscript(' 'BUILD_SCRIPT_LOADER = ["${pkgs.stdenv.cc.bintools.dynamicLinker}", "--library-path", "${pkgs.glibc}/lib:${pkgs.stdenv.cc.cc.lib}/lib"]


      def buildscript_command(buildscript: str) -> list[str]:
          with open(buildscript, "rb") as f:
              if f.read(4) == b"\x7fELF":
                  return [*BUILD_SCRIPT_LOADER, buildscript]
          return [buildscript]


      def run_buildscript(' \
        --replace-fail '            os.path.abspath(buildscript),' \
          '            buildscript_command(os.path.abspath(buildscript)),' \
        --replace-fail '    env = dict(os.environ, **env)' \
          '    env = dict(os.environ, **env, BUCK2_RUST_BUILD_SCRIPT_LOADER=" ".join(BUILD_SCRIPT_LOADER))'
    ''}

  ''
