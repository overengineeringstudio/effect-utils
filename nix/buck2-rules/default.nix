{
  pkgs,
  buck2,
  src,
}:

let
  lib = pkgs.lib;
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  files = inventory.files;
  sortedFiles = builtins.sort builtins.lessThan files;
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
    BUCK
    mkdir -p "$out/packages/@overeng/buck2-tools"
    cat > "$out/packages/@overeng/buck2-tools/BUCK" <<'BUCK'
    filegroup(
        name = "package_tree_runtime",
        srcs = {
            "package-tree.ts": "src/package-tree.ts",
            "real-path.ts": "src/real-path.ts",
        },
        visibility = ["PUBLIC"],
    )

    filegroup(
        name = "package_command_runtime",
        srcs = {
            "package-command-runner.ts": "src/package-command-runner.ts",
            "real-path.ts": "src/real-path.ts",
            "typescript-runner.ts": "src/typescript-runner.ts",
        },
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
      # cannot use that interpreter inside the Nix sandbox. Run it through the
      # declared loader and libraries without changing the product's ELF.
      substituteInPlace "$out/prelude/rust/tools/buildscript_run.py" \
        --replace-fail '            os.path.abspath(buildscript),' \
        '            ["${pkgs.stdenv.cc.bintools.dynamicLinker}", "--library-path", "${pkgs.glibc}/lib:${pkgs.stdenv.cc.cc.lib}/lib", os.path.abspath(buildscript)],'
    ''}

  ''
