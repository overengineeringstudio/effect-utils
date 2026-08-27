{ pkgs }:
let
  release = rec {
    version = "2026-08-22";
    releaseBaseUrl = "https://github.com/facebook/buck2/releases/download/${version}";
    prelude = rec {
      revision = "b662bc5f374762afc05e7033d6a0f8d4da462d45";
      url = "https://github.com/facebook/buck2-prelude/archive/${revision}.tar.gz";
      hash = "sha256-sblbKPjU4t/kK0DyCt16/KW6DqmZaJRA/lXXyE3Ez1k=";
    };
    platforms = {
      x86_64-linux = {
        executionPlatform = "x86_64-linux";
        suffix = "x86_64-unknown-linux-gnu";
        buck2Hash = "sha256-ZcsR/hR5Szrz5zK2Up8scs5OXZKdEeYMAcMfXMuDi6c=";
        rustProjectHash = "sha256-oFfEizUVfMsG7Q33HXf3API5INeaLiXEAsIkjLwENoU=";
      };
      aarch64-linux = {
        executionPlatform = "aarch64-linux";
        suffix = "aarch64-unknown-linux-gnu";
        buck2Hash = "sha256-935OTtLIOgWqh0vFfC+P64yElBLQkWdLNccion3Ph5o=";
        rustProjectHash = "sha256-4zhvmVOM/w+R8VJ74HoNhrkLM4gX6MxrXvHc+Q5Kikg=";
      };
      aarch64-darwin = {
        executionPlatform = "aarch64-macos";
        suffix = "aarch64-apple-darwin";
        buck2Hash = "sha256-odZQ/iiMmM0XCMk6hO2lvRtQ5PCQ93WeSkjtKXfDNS8=";
        rustProjectHash = "sha256-1kI0OHkBV8Cq9YR3T2Fyvn9jk9ZHD9sDD/Zx5eCDk3M=";
      };
    };
  };
  system = pkgs.stdenv.hostPlatform.system;
  platform =
    release.platforms.${system}
      or (throw "Buck2 release ${release.version} does not support ${system}");
in
pkgs.buck2.overrideAttrs (oldAttrs: {
  version = "unstable-${release.version}";
  srcs = [
    (pkgs.fetchurl {
      url = "${release.releaseBaseUrl}/buck2-${platform.suffix}.zst";
      hash = platform.buck2Hash;
    })
    (pkgs.fetchurl {
      url = "${release.releaseBaseUrl}/rust-project-${platform.suffix}.zst";
      hash = platform.rustProjectHash;
    })
  ];
  passthru = oldAttrs.passthru // {
    executionPlatform = platform.executionPlatform;
    prelude = pkgs.fetchurl {
      inherit (release.prelude) url hash;
    };
  };
})
