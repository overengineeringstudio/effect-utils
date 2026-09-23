{
  pkgs,
  buck2,
}:

{
  product,
  preparedDeps,
  producerCommit,
  repositoryRoot ? ../..,
  repositorySource ? null,
  rootProjection ? null,
  expectedSha256 ? null,
}:

let
  lib = pkgs.lib;
  source =
    if repositorySource == null then
      lib.fileset.toSource {
        root = repositoryRoot;
        fileset = lib.fileset.unions [
          (repositoryRoot + "/BUCK")
          (repositoryRoot + "/package.json")
          (repositoryRoot + "/.oxfmtrc.json")
          (repositoryRoot + "/.oxlintrc.json")
          (repositoryRoot + "/context")
          (repositoryRoot + "/genie/weaver-registry")
          (repositoryRoot + "/devenv.lock")
          (repositoryRoot + "/devenv.yaml")
          (repositoryRoot + "/flake.lock")
          (repositoryRoot + "/flake.nix")
          (repositoryRoot + "/megarepo.kdl")
          (repositoryRoot + "/megarepo.lock")
          (repositoryRoot + "/patches")
          (repositoryRoot + "/nix/weaver-flake/flake.nix")
          (repositoryRoot + "/scripts")
          (repositoryRoot + "/tsconfig.lint.json")
          (repositoryRoot + "/buck2")
          (repositoryRoot + "/packages/@overeng")
        ];
      }
    else
      repositorySource;
  prelude = buck2.passthru.prelude;
  generation = builtins.hashString "sha256" "nix-buck-product:${pkgs.bun}";
  standaloneRoot =
    if rootProjection == null then
      import ./standalone-root.nix {
        inherit
          pkgs
          source
          prelude
          generation
          ;
      }
    else
      null;
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
  src = if standaloneRoot == null then source else standaloneRoot;

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

    ${lib.optionalString (rootProjection != null) ''
      cp -R ${rootProjection}/. .
      chmod -R u+w .buck2 buck2 BUCK .buckconfig .buckroot
    ''}


    mkdir -p nix-deps
    cp -a ${preparedDeps}/node_modules nix-deps/tree
    chmod -R u+w nix-deps/tree
    cp -a packages/@overeng nix-deps/tree/@overeng
    rm -rf nix-deps/tree/@overeng/${lib.escapeShellArg packageBase}
    SOURCE_MODULES=${lib.escapeShellArg preparedPackageModules} \
      DEST_MODULES="$PWD/nix-deps/tree" \
      PREPARED_ROOT=${lib.escapeShellArg preparedDeps} \
      ${pkgs.bun}/bin/bun -e '
        import { access, mkdir, readdir, realpath, symlink } from "node:fs/promises"
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
              } else if (!(resolved === preparedRoot || resolved.startsWith(preparedRoot + "/"))) {
                throw new Error(`prepared dependency link escapes its prepared root: ''${sourcePath}`)
              }
            } else {
              throw new Error(`prepared dependency projection expected only directories and links: ''${sourcePath}`)
            }
          }
        }
        try {
          await access(source)
          await project(source, destination)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
        }
        const workspaceRoot = join(preparedRoot, "packages", "@overeng")
        for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const destinationPackage = join(destination, "@overeng", entry.name)
          const sourceModules = join(workspaceRoot, entry.name, "node_modules")
          try {
            await access(destinationPackage)
            await access(sourceModules)
          } catch {
            continue
          }
          await project(sourceModules, join(destinationPackage, "node_modules"))
        }
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
    ${
      if rootProjection == null then
        ''
          ${pkgs.bun}/bin/bun ${./rewrite-package-tree.mjs} "$package_buck"
        ''
      else
        ''
          PACKAGE_BUCK="$package_buck" ${pkgs.bun}/bin/bun -e '
            const path = process.env.PACKAGE_BUCK
            if (path === undefined) throw new Error("PACKAGE_BUCK is unset")
            let source = await Bun.file(path).text()
            const rulesLoad = "load(\"@rules//buck2:materialization.bzl\", \"export_materialization_inputs\", \"package_tree\")"
            if (source.split(rulesLoad).length !== 2) {
              throw new Error("Expected exactly one @rules package_tree load")
            }
            const from = "    node_modules = \"//:node_modules\","
            if (source.split(from).length !== 2) {
              throw new Error("Expected exactly one consumer node_modules target")
            }
            source = source.replace(from, "    node_modules = \"//:nix_prepared_node_modules\",")
            await Bun.write(path, source)
          '
        ''
    }

    artifact="$(${buck2}/bin/buck2 --isolation-dir nix-product-${safeName} build ${lib.escapeShellArg target} --local-only --no-remote-cache --console simple --show-simple-output)"
    test -f "$artifact"
    cp "$artifact" ${lib.escapeShellArg outputName}
    ${lib.optionalString (product.kind == "javascript") ''
      descriptor="$(${buck2}/bin/buck2 --isolation-dir nix-product-${safeName}-descriptor build ${lib.escapeShellArg "${target}[descriptor]"} --local-only --no-remote-cache --console simple --show-simple-output)"
      test -f "$descriptor"
      jq -cS . "$descriptor" > descriptor.json
    ''}
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
    ${lib.optionalString (product.kind == "javascript") ''
      cp descriptor.json "$out/descriptor.json"
    ''}
    runHook postInstall
  '';

  passthru = {
    inherit
      preparedDeps
      producerCommit
      source
      standaloneRoot
      target
      repositorySource
      rootProjection
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
