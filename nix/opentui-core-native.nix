{ pkgs }:

let
  lib = pkgs.lib;
  packages = {
    aarch64-darwin = {
      name = "@opentui/core-darwin-arm64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-arm64/-/core-darwin-arm64-0.4.1.tgz";
      hash = "sha512-ocs73hj9n0zLArOTpUWIXCWU6ERThG+3wQzO78EvfaR4hb5FRrDHGKWTzXpr6ukSKsUtKdztK5XYTPsJ5e3vww==";
    };
    x86_64-darwin = {
      name = "@opentui/core-darwin-x64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-x64/-/core-darwin-x64-0.4.1.tgz";
      hash = "sha512-YogRtDBfxGeOkcSHDMsGkKFBIt3cWPMPGNu2AmEN6a5KKjDYwAZCudwbDJaUbZDCJjfAUHz9iXjhJVXJBXs9vQ==";
    };
    aarch64-linux = {
      name = "@opentui/core-linux-arm64";
      url = "https://registry.npmjs.org/@opentui/core-linux-arm64/-/core-linux-arm64-0.4.1.tgz";
      hash = "sha512-sBZTS1eEGeVSQ8fAmDALKQcT7FckrhK64oHfEO7W0lJ+lXapfJuOKtTM33na54V56GAM9guk4RD4cbPeTXEh4g==";
    };
    x86_64-linux = {
      name = "@opentui/core-linux-x64";
      url = "https://registry.npmjs.org/@opentui/core-linux-x64/-/core-linux-x64-0.4.1.tgz";
      hash = "sha512-9/xjYGzX5RdUl0qmGQY0OCayjJ4VffDhsBmApQdseUkMT6LGL3RumI4zPK3Y9vo1fuy6ffLnriLFOktOgutXDg==";
    };
  };
  muslPackages = {
    aarch64-linux = {
      name = "@opentui/core-linux-arm64-musl";
      url = "https://registry.npmjs.org/@opentui/core-linux-arm64-musl/-/core-linux-arm64-musl-0.4.1.tgz";
      hash = "sha512-Eps9qB+vQ/Lel4ZYqMH87Um9oiU17Vu4oWzvRi40Yf+69vA1a3R4D7KUCeY3OxKWnRnwAHkMU9TxNnjKngPH/w==";
    };
    x86_64-linux = {
      name = "@opentui/core-linux-x64-musl";
      url = "https://registry.npmjs.org/@opentui/core-linux-x64-musl/-/core-linux-x64-musl-0.4.1.tgz";
      hash = "sha512-UYcp8XGX4DZXN+VYUVuCrJkbFMJ0L+VUVu0t5KqqaeJ74fI4NZ+DmwNqPPg1+C+EIzoW4QChlEUdhlZRdiEQiA==";
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
      or (throw "opentui-core-native: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  primary = mkPackage spec;
  musl = muslPackages.${pkgs.stdenv.hostPlatform.system} or null;
in
primary
// {
  packages = [ primary ] ++ lib.optional (musl != null) (mkPackage musl);
}
