{ nativeBundle, release, signerFile }:
let
  flake = builtins.getFlake (toString ../../../..);
  pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; };
  product = import ./default.nix {
    inherit pkgs nativeBundle release;
    nixpkgsRevision = flake.inputs.nixpkgs.rev;
    signer = builtins.fromJSON (builtins.readFile signerFile);
    # Watchman requires a self-contained, relocated build before bundling.
    includeWatchman = false;
  };
in
pkgs.linkFarm "permissions-host-experiment-${release}-unsigned" [
  { name = "hostApp"; path = product.hostApp; }
  { name = "ctl"; path = product.ctl; }
  { name = "ctl-config.json"; path = product.ctlConfig; }
  { name = "desired-descriptor.json"; path = product.desiredDescriptor; }
  { name = "generation"; path = product.generation; }
]
