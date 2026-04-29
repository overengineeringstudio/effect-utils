{ pkgs }:

let
  lib = pkgs.lib;
  packages = {
    aarch64-darwin = {
      name = "@opentui/core-darwin-arm64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-arm64/-/core-darwin-arm64-0.1.88.tgz";
      hash = "sha512-oGRexWwZFeQJymOK5ORrLrwJUbPHMYaFa0EcLnlhvPnymm1xyMcRKm39ez0WSIdtiCCi/PmMHX95CfyyJB5VMA==";
    };
    x86_64-darwin = {
      name = "@opentui/core-darwin-x64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-x64/-/core-darwin-x64-0.1.88.tgz";
      hash = "sha512-ddnruYpXt7gXsAqZoQzNrHtZ50niYQfESVT3rhE5qgsz7zoWBdKe/RxLKcb6zQmHMZML6SjSh0NrMG86lsH4dQ==";
    };
    aarch64-linux = {
      name = "@opentui/core-linux-arm64";
      url = "https://registry.npmjs.org/@opentui/core-linux-arm64/-/core-linux-arm64-0.1.88.tgz";
      hash = "sha512-jfcU/Sw8re3aWWb9cQ4OXmVNp/pchu6lgDRqvfy0EKTpzd7CNIu6a0xm+rcUKiPO7BrTrwtumT5/jZWWgCdHlg==";
    };
    x86_64-linux = {
      name = "@opentui/core-linux-x64";
      url = "https://registry.npmjs.org/@opentui/core-linux-x64/-/core-linux-x64-0.1.88.tgz";
      hash = "sha512-nyfilOYLu6XWRlPl1R0Y6WzdL+jVdIFnwShBWcZL+QC5HiJnQc6LKy5yX8uv0fVbY5xs1wBvlHVeUj1UwFQyFQ==";
    };
  };
  spec =
    packages.${pkgs.stdenv.hostPlatform.system}
      or (throw "opentui-core-native: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  tarball = pkgs.fetchurl {
    inherit (spec) url hash;
  };
  package = pkgs.runCommand (lib.strings.sanitizeDerivationName spec.name)
    { nativeBuildInputs = [ pkgs.gnutar ]; }
    ''
      mkdir -p "$out"
      tar -xzf ${tarball} --strip-components=1 -C "$out"
    '';
in
{
  inherit (spec) name;
  inherit package;
}
