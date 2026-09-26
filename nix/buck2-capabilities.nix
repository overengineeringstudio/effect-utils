{
  pkgs,
  src,
  capabilityPackages,
}:

let
  manifest = builtins.fromJSON (builtins.readFile (src + "/buck2-member.json"));
  executableCapabilities = builtins.filter (capability: !(capability ? _tag)) manifest.capabilities;
  authorityCapabilities = builtins.concatMap (
    capability: if capability._tag or null == "ToolchainAuthority" then capability.provides else [ ]
  ) manifest.capabilities;
  capabilities = builtins.sort (left: right: left.toolId < right.toolId) (
    executableCapabilities ++ authorityCapabilities
  );
  projectionInputs = map (
    capability:
    let
      package =
        if builtins.hasAttr capability.flakePackage capabilityPackages then
          builtins.getAttr capability.flakePackage capabilityPackages
        else
          throw "buck2-capabilities: missing flake package ${capability.flakePackage} for ${capability.toolId}";
      closure = pkgs.closureInfo { rootPaths = [ package ]; };
    in
    {
      inherit capability;
      nixOutputPath = package;
      closurePathsFile = "${closure}/store-paths";
    }
  ) capabilities;
  input = pkgs.writeText "buck2-capability-projection-input.json" (builtins.toJSON projectionInputs);
  platform =
    if pkgs.stdenv.hostPlatform.isDarwin then "aarch64-macos" else pkgs.stdenv.hostPlatform.system;
in
pkgs.runCommand "buck2-capabilities" { nativeBuildInputs = [ pkgs.bun ]; } ''
  bun ${src}/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts \
    --input ${input} \
    --output "$out" \
    --platform ${platform}
''
