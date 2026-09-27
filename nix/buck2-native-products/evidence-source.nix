{
  pkgs,
  buck2,
  capabilities,
  repositoryRoot,
}:
let
  lib = pkgs.lib;
  cargoArchives = import ../workspace-tools/lib/buck2-cargo-archives.nix {
    inherit pkgs;
    thirdPartyBuckFiles = [ (repositoryRoot + "/rust/third-party/BUCK") ];
  };
  source = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (repositoryRoot + "/BUCK")
      (repositoryRoot + "/package.json")
      (repositoryRoot + "/pnpm-workspace.yaml")
      (repositoryRoot + "/rust-toolchain.toml")
      (repositoryRoot + "/.oxfmtrc.json")
      (repositoryRoot + "/.oxlintrc.json")
      (repositoryRoot + "/devenv.lock")
      (repositoryRoot + "/devenv.yaml")
      (repositoryRoot + "/flake.lock")
      (repositoryRoot + "/flake.nix")
      (repositoryRoot + "/megarepo.kdl")
      (repositoryRoot + "/megarepo.lock")
      (repositoryRoot + "/patches/@myobie__pty@0.10.0.patch")
      (repositoryRoot + "/genie/weaver-registry")
      (repositoryRoot + "/nix/weaver-flake/flake.nix")
      (repositoryRoot + "/.buckconfig")
      (repositoryRoot + "/.buckroot")
      (repositoryRoot + "/buck2")
      (repositoryRoot + "/rust")
      (repositoryRoot + "/packages/@overeng/otel-scrape")
      (repositoryRoot + "/packages/@overeng/otelite")
      (repositoryRoot + "/nix/buck2-native-products/evidence-source.nix")
    ];
  };
in
pkgs.stdenv.mkDerivation {
  pname = "buck2-evidence";
  version = "0.0.0";
  src = source;
  nativeBuildInputs = [
    buck2
    pkgs.bun
    pkgs.cacert
  ]
  ++ lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.autoPatchelfHook;
  # The toolchain links Linux binaries against the portable FHS loader; the
  # installed binary is repointed at the Nix loader like realized products.
  buildInputs = lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.stdenv.cc.cc.lib;
  dontConfigure = true;
  dontFixup = true;
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home" XDG_CACHE_HOME="$TMPDIR/cache" XDG_RUNTIME_DIR="$TMPDIR/runtime"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2
    bun ${capabilities.src}/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts \
      --input ${capabilities.input} \
      --output .buck2/capabilities \
      --platform ${capabilities.platform}
    # The bundled prelude emits `#!/usr/bin/env bash` scripts, but Nix's Linux
    # sandbox has no /usr/bin/env. Keep Buck's bundled prelude as the source of
    # truth and patch only the interpreter of scripts it generates here.
    ${buck2}/bin/buck2 --isolation-dir nix-evidence expand-external-cell prelude
    substituteInPlace prelude/utils/cmd_script.bzl prelude/rust/cargo_buildscript.bzl \
      --replace-fail '#!/usr/bin/env bash' '#!${pkgs.bash}/bin/bash'
    ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
      # Build scripts carry the portable /lib64 loader, which the sandbox lacks.
      # Run them through the Nix loader instead of rewriting the toolchain.
      substituteInPlace prelude/rust/tools/buildscript_run.py \
        --replace-fail '            os.path.abspath(buildscript),' \
        '            ["${pkgs.stdenv.cc.bintools.dynamicLinker}", "--library-path", "${pkgs.stdenv.cc.cc.lib}/lib", os.path.abspath(buildscript)],'
    ''}
    artifact="$(${buck2}/bin/buck2 --isolation-dir nix-evidence build --config external_cells.prelude=disabled --config nix_store.crates_root=${cargoArchives} --local-only --no-remote-cache --console simple --show-simple-output effect_utils//rust/buck2-tools/evidence:buck2-evidence)"
    test -f "$artifact"
    cp "$artifact" ./buck2-evidence
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ./buck2-evidence "$out/bin/buck2-evidence"
    ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''autoPatchelf "$out"''}
    runHook postInstall
  '';
  meta = {
    description = "Buck-built content-addressed build evidence ingester and trace resolver";
    mainProgram = "buck2-evidence";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
