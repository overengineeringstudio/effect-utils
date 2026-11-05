{ pkgs }:
{ name, products }:
let
  lib = pkgs.lib;
  library = lib.findFirst (p: p ? rustc) (throw "Buck composition requires a library") products;
  contract = pkgs.writeText "composition-contract.nix" (
    builtins.readFile ./buck2-build-product-contract.nix
  );
  plan = pkgs.writeText "composition-plan.nix" (
    builtins.readFile ./buck2-product-composition-plan.nix
  );
  inputs = pkgs.writeText "composition-inputs.json" (
    builtins.toJSON (
      map (p: {
        root = toString p;
        descriptor = toString p.descriptorPath;
      }) products
    )
  );
in
pkgs.runCommand name
  {
    dontStrip = true;
    passthru = {
      inherit (library) rustc rustTarget panicStrategy;
      descriptorPaths = map (p: p.descriptorPath) products;
    };
  }
  ''
    set -euo pipefail
    state=$(mktemp -d)
    NIX_STATE_DIR="$state/state" NIX_LOG_DIR="$state/log" HOME="$state" \
      ${pkgs.nix}/bin/nix-instantiate --eval --strict --json --readonly-mode \
        --store dummy:// --option experimental-features "" \
        --argstr contract ${contract} --argstr plan ${plan} --argstr inputs ${inputs} \
        --expr '{ contract, plan, inputs }:
          let
            rows = builtins.fromJSON (builtins.readFile inputs);
            descriptors = map (p: (import contract).validateDescriptor
              (builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile p.descriptor)))) rows;
          in import plan descriptors' > plan.json
    ${pkgs.python3}/bin/python ${./buck2-product-compose.py} ${inputs} plan.json "$out"
  ''
