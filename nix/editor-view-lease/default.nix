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
    $CC -std=c11 -Wall -Wextra -Werror -O2 -DEU_LEASE_TEST_UNKNOWN_FS \
      editor-view-lease.c -o editor-view-lease-unknown-fs
    $CC -std=c11 -Wall -Wextra -Werror -O2 -DEU_LEASE_FFI -fPIC \
      ${if stdenv.isDarwin then "-dynamiclib" else "-shared"} \
      editor-view-lease.c -o libeditor-view-lease${stdenv.hostPlatform.extensions.sharedLibrary}
    $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-lease-test-child.c -o editor-view-lease-test-child
    $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-lease-execve-test.c -o editor-view-lease-execve-test
    ${lib.optionalString stdenv.isLinux ''
      $CC -std=c11 -Wall -Wextra -Werror -O2 editor-view-reader-infrastructure-test-child.c -o editor-view-reader-infrastructure-test-child
    ''}
    runHook postBuild
  '';
  doCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
  checkPhase = ''
    runHook preCheck
    ./editor-view-lease-execve-test
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 editor-view-lease "$out/bin/editor-view-lease"
    install -Dm755 libeditor-view-lease${stdenv.hostPlatform.extensions.sharedLibrary} \
      "$out/lib/libeditor-view-lease${stdenv.hostPlatform.extensions.sharedLibrary}"
    install -Dm755 editor-view-lease-test-child "$testHelpers/bin/editor-view-lease-test-child"
    install -Dm755 editor-view-lease-unknown-fs "$testHelpers/bin/editor-view-lease-unknown-fs"
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
