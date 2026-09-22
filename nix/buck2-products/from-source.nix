{
  pkgs,
  buck2,
}:

{
  capabilities,
  pnpmArchives,
  product,
  producerCommit,
  repositoryRoot ? ../..,
  repositorySource ? null,
  expectedSha256 ? null,
}:

let
  lib = pkgs.lib;
  source =
    if repositorySource == null then
      lib.fileset.toSource {
        root = repositoryRoot;
        fileset = lib.fileset.unions [
          (repositoryRoot + "/.buckconfig")
          (repositoryRoot + "/.buckroot")
          (repositoryRoot + "/BUCK")
          (repositoryRoot + "/package.json")
          (repositoryRoot + "/.oxfmtrc.json")
          (repositoryRoot + "/.oxlintrc.json")
          (repositoryRoot + "/buck2-member.json")
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
          (repositoryRoot + "/buck2")
          (repositoryRoot + "/packages/@overeng")
        ];
      }
    else
      repositorySource;

  target = product.target;
  productName = product.name;
  outputName = product.outputName;
  safeName = lib.replaceStrings [ "@" "/" ] [ "" "-" ] productName;
  buckGlobalArgs = "--isolation-dir nix-product-${safeName}";
  buckBuildArgs = "--config nix_store.root=${pnpmArchives} --local-only --no-remote-cache --console simple --show-simple-output";
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
    pkgs.cacert
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
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" .buck2/capabilities
    cp -R ${capabilities}/. .buck2/capabilities

    artifact="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} ${lib.escapeShellArg target})"
    test -f "$artifact"
    cp "$artifact" ${lib.escapeShellArg outputName}
    ${lib.optionalString (product.kind == "javascript") ''
      descriptor="$(${buck2}/bin/buck2 ${buckGlobalArgs} build ${buckBuildArgs} ${lib.escapeShellArg "${target}[descriptor]"})"
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
      capabilities
      pnpmArchives
      producerCommit
      repositorySource
      source
      standaloneRoot
      target
      ;
    artifactName = outputName;
    productKind = product.kind;
    expectedProductSha256 = expectedSha256;
  };
}
