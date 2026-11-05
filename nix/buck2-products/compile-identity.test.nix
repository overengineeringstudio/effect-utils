# Import with a locked flake and system; evaluation never realizes a product.
{
  flake,
  system ? "x86_64-linux",
}:
let
  revisionA = "1111111111111111111111111111111111111111";
  revisionB = "2222222222222222222222222222222222222222";
  pkgs = import flake.inputs.nixpkgs { inherit system; };
  repositoryRoot = /. + builtins.unsafeDiscardStringContext flake.outPath;
  settingsFile = repositoryRoot + "/nix/gh-settings-genie.nix";
  buckInputs = import ./buck-inputs.nix {
    inherit (pkgs) lib;
    inherit repositoryRoot;
  };
  rules = import ./root-projection.nix {
    inherit pkgs buckInputs repositoryRoot;
  };
  packagesFor =
    sourceInfo:
    ((import (flake.outPath + "/flake.nix")).outputs (
      flake.inputs
      // {
        self = flake // {
          inherit sourceInfo;
        };
      }
    )).packages.${system};
  cleanA = packagesFor { rev = revisionA; };
  cleanB = packagesFor { rev = revisionB; };
  dirty = packagesFor {
    dirtyRev = "${revisionA}-dirty";
    dirtyShortRev = "1111111-dirty";
  };
  compile = packages: packages.buck-product-genie-from-source.compileProduct;
  stamp = packages: packages.buck-product-genie-from-source;
  compilePaths = map (packages: (compile packages).drvPath) [
    cleanA
    cleanB
    dirty
  ];
  stampPaths = map (packages: (stamp packages).drvPath) [
    cleanA
    cleanB
    dirty
  ];
  activationUsesCompile =
    packages: packages.gh-settings-genie.compileProduct.drvPath == (compile packages).drvPath;
in
assert !(builtins.elem settingsFile buckInputs.files);
assert !(builtins.pathExists (rules + "/nix/gh-settings-genie.nix"));
assert builtins.all (path: path == builtins.head compilePaths) compilePaths;
assert (stamp cleanA).producerCommit == revisionA;
assert (stamp cleanB).producerCommit == revisionB;
assert (stamp dirty).producerCommit == "0000000000000000000000000000000000000000";
assert builtins.length (flake.inputs.nixpkgs.lib.unique stampPaths) == 3;
assert builtins.all activationUsesCompile [
  cleanA
  cleanB
  dirty
];
assert (stamp cleanA).compileProduct.drvPath == (compile cleanA).drvPath;
assert (cleanA.gh-settings-genie).drvPath == (cleanB.gh-settings-genie).drvPath;
assert cleanA.gh-settings-genie.artifactName == (stamp cleanA).artifactName;
assert
  cleanA.gh-settings-genie.expectedDescriptor == cleanA.genie.checkedDescriptor
  // {
    externalCapabilities = flake.inputs.nixpkgs.lib.unique (
      cleanA.genie.checkedDescriptor.externalCapabilities ++ [ "gh" ]
    );
  };
{
  inherit compilePaths stampPaths;
  revisionAndDirtyIndependent = true;
  settingsUsesCompile = true;
  settingsRecipeOutsideProjection = true;
}
