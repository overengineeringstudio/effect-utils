# Option registration must stay lazy with respect to the task configuration.
# Exercise the real module fixed point, without fabricating task definitions.
{
  pkgs,
  inputs,
  baseCapabilities,
  preparedTools,
}:
let
  evaluated = pkgs.lib.evalModules {
    modules = [ (import ./quick-contracts.nix { inherit baseCapabilities preparedTools; }) ];
    specialArgs = { inherit pkgs inputs; };
  };
in
assert evaluated.options.effectUtils.quickContracts.package.readOnly;
assert evaluated.options.effectUtils.quickContracts.capabilities.readOnly;
true
