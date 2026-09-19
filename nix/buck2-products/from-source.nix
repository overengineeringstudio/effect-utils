{
  pkgs,
  buck2,
}:

{
  product,
  preparedDeps,
  producerCommit,
  repositoryRoot ? ../..,
  expectedSha256 ? null,
}:

let
  lib = pkgs.lib;
  source = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (repositoryRoot + "/BUCK")
      (repositoryRoot + "/buck2")
      (repositoryRoot + "/packages/@overeng")
    ];
  };
  prelude = buck2.passthru.prelude;
  generation = builtins.hashString "sha256" "nix-buck-product:${pkgs.bun}";
  bunClosure = pkgs.closureInfo { rootPaths = [ pkgs.bun ]; };
  target = product.target;
  productName = product.name;
  packagePath = product.packageTreePath or product.packagePath;
  packageBase = builtins.baseNameOf packagePath;
  preparedPackageModules = preparedDeps + "/${packagePath}/node_modules";
  outputName = product.outputName;
  safeName = lib.replaceStrings [ "@" "/" ] [ "" "-" ] productName;
in
assert lib.assertMsg (
  builtins.match "[0-9a-f]{40}" producerCommit != null
) "buck2-products: producerCommit must be a full lowercase Git commit";
pkgs.stdenv.mkDerivation {
  pname = "${safeName}-buck2-from-source";
  version = product.version or "0.0.0";
  src = source;

  nativeBuildInputs = [
    buck2
    pkgs.bun
    pkgs.cacert
    pkgs.gnutar
    pkgs.gzip
    pkgs.jq
  ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_RUNTIME_DIR="$TMPDIR/runtime"
    export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"

    touch .buckroot
    cat > .buckconfig <<'BUCKCONFIG'
    [cells]
      effect_utils = .
      capabilities = .buck2/capabilities
      prelude = prelude

    [cell_aliases]
      config = prelude
      ovr_config = prelude
      fbsource = prelude
      toolchains = effect_utils

    [parser]
      target_platform_detector_spec = target:effect_utils//...->effect_utils//buck2/platforms:host_platform

    [build]
      execution_platforms = effect_utils//buck2/platforms:host_execution_platform

    [buck2]
      file_watcher = notify
      digest_algorithms = SHA256
      remote_cache_enabled = false
      allow_cache_uploads = false

    [project]
      ignore = **/__pycache__,**/dist,**/target,**/target/**,.devenv,.git,buck-out,node_modules,packages/.editor-view,target,tmp
    BUCKCONFIG

    mkdir -p prelude
    tar -xzf ${prelude} --strip-components=1 -C prelude

    mkdir -p .buck2/capabilities
    cat > .buck2/capabilities/defs.bzl <<'CAPABILITIES_HEAD'
    GENERATION = "${generation}"
    CAPABILITIES = {
      "${
        if pkgs.stdenv.hostPlatform.isDarwin then "aarch64-macos" else pkgs.stdenv.hostPlatform.system
      }": {
        "bun": {
          "generation": "${generation}",
          "contentDigest": "@bunDigest@",
          "closureIdentity": "${pkgs.bun}",
          "executableStorePath": "${pkgs.bun}/bin/bun",
          "closureStorePaths": [
    CAPABILITIES_HEAD
    sort -u ${bunClosure}/store-paths | sed 's|^|          "|; s|$|",|' >> .buck2/capabilities/defs.bzl
    cat >> .buck2/capabilities/defs.bzl <<'CAPABILITIES_TAIL'
          ],
        },
      },
    }
    CAPABILITIES_TAIL
    substituteInPlace .buck2/capabilities/defs.bzl \
      --replace-fail '@bunDigest@' "$(sha256sum ${pkgs.bun}/bin/bun | cut -d' ' -f1)"

    cat > buck2/toolchains/BUCK <<'TOOLCHAINS'
    load("//buck2/toolchains:defs.bzl", "bun_toolchain")
    load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
    bun_toolchain(
        name = "bun",
        capabilities = CAPABILITIES,
        generation = GENERATION,
        visibility = ["PUBLIC"],
    )
    TOOLCHAINS

    cat > buck2/dependencies/BUCK <<'DEPENDENCIES'
    load("//buck2/dependencies:defs.bzl", "pnpm_platform_gated_packages")
    pnpm_platform_gated_packages(
        name = "platform_gated_packages",
        capabilities = {},
        families = {},
        visibility = ["PUBLIC"],
    )
    DEPENDENCIES

    mkdir -p nix-deps
    cp -a ${preparedDeps}/node_modules nix-deps/tree
    chmod -R u+w nix-deps/tree
    cp -a packages/@overeng nix-deps/tree/@overeng
    rm -rf nix-deps/tree/@overeng/${lib.escapeShellArg packageBase}
    SOURCE_MODULES=${lib.escapeShellArg preparedPackageModules} \
      DEST_MODULES="$PWD/nix-deps/tree" \
      PREPARED_ROOT=${lib.escapeShellArg preparedDeps} \
      ${pkgs.bun}/bin/bun -e '
        import { mkdir, readdir, realpath, symlink } from "node:fs/promises"
        import { dirname, join, relative } from "node:path"
        const source = process.env.SOURCE_MODULES
        const destination = process.env.DEST_MODULES
        const preparedRoot = process.env.PREPARED_ROOT
        if (source === undefined || destination === undefined || preparedRoot === undefined) {
          throw new Error("prepared dependency projection environment is incomplete")
        }
        const rootModules = join(preparedRoot, "node_modules")
        const project = async (sourceDirectory, destinationDirectory) => {
          await mkdir(destinationDirectory, { recursive: true })
          for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
            const sourcePath = join(sourceDirectory, entry.name)
            const destinationPath = join(destinationDirectory, entry.name)
            if (entry.isDirectory()) {
              await project(sourcePath, destinationPath)
            } else if (entry.isSymbolicLink()) {
              const resolved = await realpath(sourcePath)
              if (resolved === rootModules || resolved.startsWith(rootModules + "/")) {
                const projectedTarget = join(destination, relative(rootModules, resolved))
                await mkdir(dirname(destinationPath), { recursive: true })
                await symlink(relative(dirname(destinationPath), projectedTarget), destinationPath)
              } else if (!(resolved === preparedRoot || resolved.startsWith(join(preparedRoot, "packages") + "/"))) {
                throw new Error(`prepared dependency link escapes its declared roots: ''${sourcePath}`)
              }
            } else {
              throw new Error(`prepared dependency projection expected only directories and links: ''${sourcePath}`)
            }
          }
        }
        await project(source, destination)
      '

    PREPARED_TREE="$PWD/nix-deps/tree" ${pkgs.bun}/bin/bun -e '
      import { chmod, readdir, realpath, rm } from "node:fs/promises"
      import { join } from "node:path"
      const root = process.env.PREPARED_TREE
      if (root === undefined) throw new Error("PREPARED_TREE is unset")
      const visit = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            await visit(path)
          } else if (entry.isSymbolicLink()) {
            try {
              await realpath(path)
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
              await chmod(directory, 0o755)
              await rm(path)
            }
          } else if (entry.isFile() && entry.name === "BUCK") {
            await rm(path)
          }
        }
      }
      await visit(root)
    '

    cat > buck2/nix_source.bzl <<'NIX_SOURCE'
    def _source_directory_impl(ctx):
        return [DefaultInfo(default_output = ctx.attrs.src)]

    source_directory = rule(
        impl = _source_directory_impl,
        attrs = { "src": attrs.source(allow_directory = True) },
    )
    NIX_SOURCE
    {
      echo 'load("//buck2:nix_source.bzl", "source_directory")'
      cat BUCK
    } > BUCK.with-nix-source
    mv BUCK.with-nix-source BUCK
    cat >> BUCK <<'ROOT_TARGET'

    source_directory(
        name = "nix_prepared_node_modules",
        src = "nix-deps/tree",
        visibility = ["PUBLIC"],
    )
    ROOT_TARGET

    package_buck=${lib.escapeShellArg packagePath}/BUCK
    PACKAGE_BUCK="$package_buck" ${pkgs.bun}/bin/bun -e '
      const path = process.env.PACKAGE_BUCK
      if (path === undefined) throw new Error("PACKAGE_BUCK is unset")
      let source = await Bun.file(path).text()
      const replaceExactlyOnce = (from, to) => {
        if (source.split(from).length !== 2) throw new Error(`Expected exactly one occurrence of: ''${from}`)
        source = source.replace(from, to)
      }
      replaceExactlyOnce(
        "load(\"//buck2:materialization.bzl\", \"export_materialization_inputs\", \"package_view\")",
        "load(\"//buck2:materialization.bzl\", \"export_materialization_inputs\", \"package_tree\")",
      )
      const opening = "package_view(\n    name = \"package_tree\",\n"
      const blockStart = source.indexOf(opening)
      if (blockStart === -1 || source.indexOf(opening, blockStart + 1) !== -1) {
        throw new Error("Expected exactly one package_tree package_view")
      }
      const blockEnd = source.indexOf("\n)\n", blockStart)
      if (blockEnd === -1) throw new Error("Unterminated package_tree package_view")
      const dependencyStart = source.indexOf("    dependency_view = \"//buck2/dependencies:view_", blockStart)
      if (dependencyStart === -1 || dependencyStart >= blockEnd) {
        throw new Error("package_tree package_view has no dependency_view")
      }
      const dependencyEnd = source.indexOf("\n", dependencyStart)
      source =
        source.slice(0, blockStart) +
        source.slice(blockStart, blockEnd).replace("package_view(", "package_tree(").replace(
          source.slice(dependencyStart, dependencyEnd),
          "    node_modules = \"//:nix_prepared_node_modules\",",
        ) +
        source.slice(blockEnd)
      await Bun.write(path, source)
    '

    artifact="$(${buck2}/bin/buck2 --isolation-dir nix-product-${safeName} build ${lib.escapeShellArg target} --local-only --no-remote-cache --console simple --show-simple-output)"
    test -f "$artifact"
    cp "$artifact" ${lib.escapeShellArg outputName}
    actual_sha256="$(sha256sum ${lib.escapeShellArg outputName} | cut -d' ' -f1)"
    ${lib.optionalString (expectedSha256 != null) ''
      test "$actual_sha256" = ${lib.escapeShellArg expectedSha256}
    ''}
    jq -nS \
      --arg schema 'effect-utils/buck-product-provenance/v1' \
      --arg producerCommit ${lib.escapeShellArg producerCommit} \
      --arg target ${lib.escapeShellArg target} \
      --arg productDigest "$actual_sha256" \
      '{schema:$schema,producerCommit:$producerCommit,target:$target,productDigest:$productDigest}' \
      > provenance.json
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp ${lib.escapeShellArg outputName} "$out/${outputName}"
    cp provenance.json "$out/provenance.json"
    runHook postInstall
  '';

  passthru = {
    inherit
      preparedDeps
      producerCommit
      source
      target
      ;
    artifactName = outputName;
    productKind = product.kind;
    expectedProductSha256 = expectedSha256;
    capabilityProjection = {
      bun = pkgs.bun;
      inherit generation;
    };
    prelude = prelude;
  };
}
