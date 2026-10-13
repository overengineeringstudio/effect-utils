{
  pkgs,
  repoRoot,
  versions ? [ "one" "two" ],
}:

let
  projector = builtins.path {
    path = repoRoot + "/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts";
    name = "capability-projection.ts";
  };
  platform =
    if pkgs.stdenv.hostPlatform.isDarwin then "aarch64-macos" else pkgs.stdenv.hostPlatform.system;
  directory = pkgs.runCommand "capability-fixture-directory" { } ''
    mkdir -p "$out"
    printf 'immutable directory input\n' > "$out/support.txt"
  '';
  makeProfile = version:
    let
      # This is a real declared executable capability, not a Buck/process mock.
      # It performs an offline npm-shaped extraction and consumes the manifest.
      tool = pkgs.writeShellScriptBin "archive-tool" ''
        set -euo pipefail
        [ "$1" = --capability-manifest ]
        manifest="$2"
        shift 2
        ${pkgs.jq}/bin/jq -e '
          .schema == "effect-utils/buck2-support-tools/v1" and
          .toolId == "archive-tool" and
          .protocol == "effect-utils/archive-tool/v1" and
          .runtimeContract == "native-executable/v1"
        ' "$manifest" >/dev/null
        [ "$1" = extract-npm ]
        [ "$2" = --archive ]
        archive="$3"
        [ "$4" = --out ]
        output="$5"
        [ "$6" = --strip-prefix ]
        [ "$7" = package ]
        [ "$8" = --directory-input ]
        directory="$9"
        ${pkgs.coreutils}/bin/mkdir -p "$output"
        ${pkgs.gnutar}/bin/tar -xf "$archive" -C "$output" --strip-components=1
        ${pkgs.coreutils}/bin/cp "$directory/support.txt" "$output/support.txt"
        printf '%s\n' '${version}' > "$output/capability-version.txt"
        ${pkgs.jq}/bin/jq -r .executableStorePath "$manifest" > "$output/executable-store-path.txt"
        ${pkgs.jq}/bin/jq -r .closureIdentity "$manifest" > "$output/closure-identity.txt"
      '';
      inputs = pkgs.writeText "capability-fixture-${version}-inputs.json" (builtins.toJSON [
        {
          capability = {
            toolId = "archive-tool";
            protocol = "effect-utils/archive-tool/v1";
            flakePackage = "fixture-archive-tool-${version}";
            executable = "bin/archive-tool";
          };
          nixOutputPath = tool;
          closurePathsFile = "${pkgs.closureInfo { rootPaths = [ tool ]; }}/store-paths";
        }
        {
          capability = {
            toolId = "support-directory";
            protocol = "effect-utils/store-directory/v1";
            flakePackage = "fixture-support-directory";
            kind = "directory";
          };
          nixOutputPath = directory;
          closurePathsFile = "${pkgs.closureInfo { rootPaths = [ directory ]; }}/store-paths";
        }
      ]);
    in
    pkgs.runCommand "buck2-capabilities-fixture-${version}" { nativeBuildInputs = [ pkgs.bun ]; } ''
      bun ${projector} \
        --input ${inputs} --output "$out" --platform ${platform}
    '';
  profiles = builtins.listToAttrs (map (version: {
    name = version;
    value = makeProfile version;
  }) versions);
in
pkgs.writeText "buck2-capability-fixture-profiles.json" (builtins.toJSON {
  inherit platform profiles;
})
