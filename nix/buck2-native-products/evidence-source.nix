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
  nativeBuildInputs = [ buck2 pkgs.cacert ];
  dontConfigure = true;
  dontFixup = true;
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home" XDG_CACHE_HOME="$TMPDIR/cache" XDG_RUNTIME_DIR="$TMPDIR/runtime"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities
    cp -R ${capabilities}/. .buck2/capabilities
    artifact="$(${buck2}/bin/buck2 --isolation-dir nix-evidence build --config nix_store.crates_root=${cargoArchives} --local-only --no-remote-cache --console simple --show-simple-output effect_utils//rust/buck2-tools/evidence:buck2-evidence)"
    test -f "$artifact"
    cp "$artifact" ./buck2-evidence
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ./buck2-evidence "$out/bin/buck2-evidence"
    runHook postInstall
  '';
  meta = {
    description = "Buck-built content-addressed build evidence ingester and trace resolver";
    mainProgram = "buck2-evidence";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
