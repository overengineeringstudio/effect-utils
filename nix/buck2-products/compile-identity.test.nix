# Import with a locked flake and system; evaluation never realizes a product.
{ flake, system ? "x86_64-linux" }:
let
  revisionA = "1111111111111111111111111111111111111111";
  revisionB = "2222222222222222222222222222222222222222";
  packagesFor = sourceInfo:
    (flake.outputs (flake.inputs // { self = flake // { inherit sourceInfo; }; })).packages.${system};
  cleanA = packagesFor { rev = revisionA; };
  cleanB = packagesFor { rev = revisionB; };
  dirty = packagesFor {
    dirtyRev = "${revisionA}-dirty";
    dirtyShortRev = "1111111-dirty";
  };
  compile = packages: packages.ci-test-shell-products.entries.gh-settings-genie-source;
  stamp = packages: packages.buck-product-genie-from-source;
  compilePaths = map (packages: (compile packages).drvPath) [ cleanA cleanB dirty ];
  stampPaths = map (packages: (stamp packages).drvPath) [ cleanA cleanB dirty ];
  activationUsesCompile = packages:
    builtins.hasAttr (compile packages).drvPath
      (builtins.getContext packages.gh-settings-genie.buildCommand);
in
assert builtins.all (path: path == builtins.head compilePaths) compilePaths;
assert (stamp cleanA).producerCommit == revisionA;
assert (stamp cleanB).producerCommit == revisionB;
assert (stamp dirty).producerCommit == "0000000000000000000000000000000000000000";
assert builtins.length (flake.inputs.nixpkgs.lib.unique stampPaths) == 3;
assert builtins.all activationUsesCompile [ cleanA cleanB dirty ];
assert (stamp cleanA).compiled.drvPath == (compile cleanA).drvPath;
{
  inherit compilePaths stampPaths;
  revisionAndDirtyIndependent = true;
  settingsUsesCompile = true;
}
