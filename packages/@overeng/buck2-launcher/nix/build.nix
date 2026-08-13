{
  pkgs,
  src,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "buck2-launcher";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [
    pkgs.bun
    pkgs.makeWrapper
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    bun build packages/@overeng/buck2-launcher/src/cli.ts \
      --compile \
      --outfile buck2-task
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    install -m 0555 buck2-task "$out/bin/buck2-task"
    wrapProgram "$out/bin/buck2-task" \
      --set-default BUCK2_BIN ${pkgs.buck2}/bin/buck2 \
      --set-default BUCK2_MACHINE_VERSION ${pkgs.buck2.version}
    runHook postInstall
  '';

  meta = {
    description = "Thin Buck2 launcher with retained build evidence";
    mainProgram = "buck2-task";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.buck2.meta.platforms;
  };
}
