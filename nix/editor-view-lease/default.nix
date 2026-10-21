{ lib, stdenv }:
stdenv.mkDerivation {
  pname = "editor-view-lease";
  version = "1";
  src = ../../packages + "/@overeng/buck2-tools/native";
  outputs = [
    "out"
    "testHelpers"
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-lease.c -o editor-view-lease
    $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-lease-test-child.c -o editor-view-lease-test-child
    ${lib.optionalString stdenv.isLinux ''
      $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-reader-infrastructure-test-child.c -o editor-view-reader-infrastructure-test-child
    ''}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 editor-view-lease "$out/bin/editor-view-lease"
    install -Dm755 editor-view-lease-test-child "$testHelpers/bin/editor-view-lease-test-child"
    ${lib.optionalString stdenv.isLinux ''
      install -Dm755 editor-view-reader-infrastructure-test-child "$testHelpers/bin/editor-view-reader-infrastructure-test-child"
    ''}
    runHook postInstall
  '';
  meta = {
    description = "Bootstrap-independent local editor generation lease launcher";
    mainProgram = "editor-view-lease";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
