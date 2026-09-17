{ pkgs }:

let
  lib = pkgs.lib;
  packages = {
    aarch64-darwin = {
      name = "@oxc-parser/binding-darwin-arm64";
      url = "https://registry.npmjs.org/@oxc-parser/binding-darwin-arm64/-/binding-darwin-arm64-0.127.0.tgz";
      hash = "sha512-obCE8B7ISKkJidjlhv9xRGJPOSDG2Yu6PRga9Ruaz35uintHxbp1Ki/Yc71wx4rj3Edrm0a1kzG1TAwit0wFpg==";
    };
    x86_64-darwin = {
      name = "@oxc-parser/binding-darwin-x64";
      url = "https://registry.npmjs.org/@oxc-parser/binding-darwin-x64/-/binding-darwin-x64-0.127.0.tgz";
      hash = "sha512-JL6Xb5IwPQT8rUzlpsX7E+AgfcdNklXNPFp8pjCQQ5MQOQo5rtEB2ui+3Hgg9Sn7Y9Egj6YOLLiHhLpdAe12Aw==";
    };
    aarch64-linux = {
      name = "@oxc-parser/binding-linux-arm64-gnu";
      url = "https://registry.npmjs.org/@oxc-parser/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-0.127.0.tgz";
      hash = "sha512-qdOfTcT6SY8gsJrrV92uyEUyjqMGPpIB5JZUG6QN5dukYd+7/j0kX6MwK1DgQj39jtUYixxPiaRUiEN1+0CXgQ==";
    };
    x86_64-linux = {
      name = "@oxc-parser/binding-linux-x64-gnu";
      url = "https://registry.npmjs.org/@oxc-parser/binding-linux-x64-gnu/-/binding-linux-x64-gnu-0.127.0.tgz";
      hash = "sha512-MYCguB9RvBvlSd6gbuNI7QwiLoCCAlGnlRJFPrzLI6U1/9wkC/WK6LtBAUln55H1Ctqw45PWmqrobKoMhsYQzQ==";
    };
  };
  muslPackages = {
    aarch64-linux = {
      name = "@oxc-parser/binding-linux-arm64-musl";
      url = "https://registry.npmjs.org/@oxc-parser/binding-linux-arm64-musl/-/binding-linux-arm64-musl-0.127.0.tgz";
      hash = "sha512-EoTCZneNFU/P2qrpEM+RHmQwt+CvDkyGESG6qhr7KaegXLZwePfbrkCDfAk8/rhxbDUVGsZILX+2tqPzFtoFWA==";
    };
    x86_64-linux = {
      name = "@oxc-parser/binding-linux-x64-musl";
      url = "https://registry.npmjs.org/@oxc-parser/binding-linux-x64-musl/-/binding-linux-x64-musl-0.127.0.tgz";
      hash = "sha512-5eY0B/bxf1xIUxb4NOTvOI3KWtBQfPWYyKAzgcrCt0mDibSZygVpO1Pz8bkeiSZ5Jj9+M09dkggG3H8I5d0Uyg==";
    };
  };
  mkPackage =
    spec:
    let
      tarball = pkgs.fetchurl {
        inherit (spec) url hash;
      };
      package =
        pkgs.runCommand (lib.strings.sanitizeDerivationName spec.name)
          { nativeBuildInputs = [ pkgs.gnutar ]; }
          ''
            mkdir -p "$out"
            tar -xzf ${tarball} --strip-components=1 -C "$out"
          '';
    in
    {
      inherit (spec) name;
      inherit package;
    };
  spec =
    packages.${pkgs.stdenv.hostPlatform.system}
      or (throw "oxc-parser-native: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  primary = mkPackage spec;
  musl = muslPackages.${pkgs.stdenv.hostPlatform.system} or null;
in
primary
// {
  packages = [ primary ] ++ lib.optional (musl != null) (mkPackage musl);
}
