# Select JSON tooling from the pinned action checkout, never consumer config.
let
  lock = builtins.fromJSON (builtins.readFile ../../../flake.lock);
  nixpkgs = lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
in
assert nixpkgs.type == "github";
"github:${nixpkgs.owner}/${nixpkgs.repo}/${nixpkgs.rev}#jq"
