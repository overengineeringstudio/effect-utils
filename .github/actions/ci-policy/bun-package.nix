# Read only the pinned action's lockfile; never copy a consumer/action worktree
# into the Nix store just to select its bootstrap runtime.
let
  lock = builtins.fromJSON (builtins.readFile ../../../flake.lock);
  nixpkgs = lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
in
assert nixpkgs.type == "github";
"github:${nixpkgs.owner}/${nixpkgs.repo}/${nixpkgs.rev}#bun"
