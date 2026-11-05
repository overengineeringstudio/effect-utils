# Settings use compile identity; revision stamps belong only to publication.
{
  pkgs,
  genie,
  sourceProduct,
}:
let
  compiled = sourceProduct.compileProduct;
  expectedDescriptor = genie.checkedDescriptor // {
    externalCapabilities = pkgs.lib.unique (genie.checkedDescriptor.externalCapabilities ++ [ "gh" ]);
  };
in
pkgs.runCommand "github-repo-settings-genie"
  {
    nativeBuildInputs = [
      pkgs.makeWrapper
      pkgs.jq
    ];
    passthru = {
      compileProduct = compiled;
      inherit expectedDescriptor;
      inherit (compiled) artifactName;
    };
  }
  ''
    jq -e --argjson expected ${pkgs.lib.escapeShellArg (builtins.toJSON expectedDescriptor)} '
      def contract: {
        externalCapabilities: (.externalCapabilities | sort),
        externalModules, modulePath, productKind, productName,
        runtimeContract, runtimeContractVersion, runtimeKind
      };
      contract == ($expected | contract)
    ' ${compiled}/descriptor.json >/dev/null
    mkdir -p "$out/bin" "$out/libexec"
    cp ${genie}/bin/genie "$out/bin/genie"
    cp ${compiled}/${compiled.artifactName} "$out/libexec/${genie.checkedDescriptor.modulePath}"
    ln -s ${genie}/libexec/node_modules "$out/libexec/node_modules"
    substituteInPlace "$out/bin/genie" \
      --replace-fail "${genie}/libexec/${genie.checkedDescriptor.modulePath}" \
        "$out/libexec/${genie.checkedDescriptor.modulePath}"
    wrapProgram "$out/bin/genie" \
      --prefix PATH : ${pkgs.lib.escapeShellArg (pkgs.lib.makeBinPath [ pkgs.gh ])}
  ''
