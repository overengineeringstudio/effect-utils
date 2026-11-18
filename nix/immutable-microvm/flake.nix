{
  description = "Credential-free immutable microVM release reference";
  # Match the repository's reviewed root nixpkgs revision.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/f4a03c008967841f2a0b3cb7c436fc6fc31671f6";
  inputs.microvm.url = "github:microvm-nix/microvm.nix/194a254693f49af939a2b53d04982bd4b276fdb3";
  inputs.microvm.inputs.nixpkgs.follows = "nixpkgs";
  outputs =
    { nixpkgs, microvm, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      catalogDigest = "sha256:${builtins.hashString "sha256" "reference-catalog"}";
      epoch = "reference-v1";
      fixture = pkgs.runCommand "authority-reference" { nativeBuildInputs = [ pkgs.rustc ]; } ''
        mkdir -p $out/bin
        rustc --edition=2024 -D warnings -O ${./reference.rs} -o $out/bin/authority
      '';
      mkGuest =
        release:
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            microvm.nixosModules.microvm
            ./guest.nix
            {
              system.stateVersion = "26.11";
              services.immutableAuthority = {
                package = fixture;
                environment = {
                  AUTHORITY_RELEASE = release;
                  AUTHORITY_CATALOG = catalogDigest;
                  AUTHORITY_EPOCH = epoch;
                };
              };
            }
          ];
        };
      guests = {
        a = mkGuest "a";
        b = mkGuest "b";
      };
      mkRelease = args: import ./release.nix ({ inherit pkgs catalogDigest epoch; } // args);
      releases = {
        a = mkRelease {
          guest = guests.a;
          release = "a";
        };
        b = mkRelease {
          guest = guests.b;
          release = "b";
        };
        badCatalog = mkRelease {
          guest = guests.a;
          release = "a";
          catalogDigest = "sha256:${builtins.hashString "sha256" "wrong-catalog"}";
        };
        badRelease = mkRelease {
          guest = guests.a;
          release = "wrong-release";
        };
        badEpoch = mkRelease {
          guest = guests.a;
          release = "a";
          epoch = "incompatible-v2";
        };
      };
    in
    {
      nixosModules.guest = import ./guest.nix;
      packages.${system} = releases // {
        default = releases.a;
      };
    };
}
