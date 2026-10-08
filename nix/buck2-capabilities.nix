{
  pkgs,
  src,
  capabilityPackages,
  extraCapabilities ? { },
}:

let
  sourceRoot = /. + builtins.unsafeDiscardStringContext (toString src);
  # The projection has only built-in runtime imports. Its other reads are the
  # generated input JSON and declared Nix package closures, not checkout files.
  # Building from this fileset makes any undeclared checkout read fail in the
  # sandbox; package sources and lockfiles remain owned by capabilityPackages.
  projectionSource = pkgs.lib.fileset.toSource {
    root = sourceRoot;
    fileset = pkgs.lib.fileset.unions [
      (sourceRoot + "/buck2-member.json")
      (sourceRoot + "/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts")
    ];
  };
  manifest = builtins.fromJSON (builtins.readFile (src + "/buck2-member.json"));
  executableCapabilities = builtins.filter (capability: !(capability ? _tag)) manifest.capabilities;
  authorityCapabilities = builtins.concatMap (
    capability: if capability._tag or null == "ToolchainAuthority" then capability.provides else [ ]
  ) manifest.capabilities;
  producerCapabilities = executableCapabilities ++ authorityCapabilities;
  extraNames = builtins.attrNames extraCapabilities;
  _validExtras = builtins.all (
    name:
    let
      extra = extraCapabilities.${name};
    in
    builtins.match "[a-z0-9]+(-[a-z0-9]+)*" name != null
    && !(builtins.elem name (map (capability: capability.toolId) producerCapabilities))
    && builtins.elem extra.kind [
      "directory"
      "executable"
    ]
    && extra ? package
    && builtins.isString extra.protocol
    && extra.protocol != ""
    && (extra.kind == "directory" || (extra ? executable && builtins.isString extra.executable))
  ) extraNames;
  capabilities = builtins.sort (left: right: left.toolId < right.toolId) (
    producerCapabilities
    ++ map (
      name:
      let
        extra = extraCapabilities.${name};
      in
      {
        toolId = name;
        inherit (extra) protocol;
        flakePackage = "consumer:${name}";
      }
      // (if extra.kind == "directory" then { kind = "directory"; } else { inherit (extra) executable; })
    ) extraNames
  );
  projectionInputs = map (
    capability:
    let
      package =
        if builtins.hasAttr capability.flakePackage capabilityPackages then
          builtins.getAttr capability.flakePackage capabilityPackages
        else if builtins.elem capability.toolId extraNames then
          extraCapabilities.${capability.toolId}.package
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
assert pkgs.lib.assertMsg _validExtras
  "buck2-capabilities: extra capabilities must be unique, named lowercase-kebab, and declare kind, package, protocol, and executable for executable inputs";
pkgs.runCommand "buck2-capabilities"
  {
    nativeBuildInputs = [ pkgs.bun ];
    passthru = {
      inherit capabilityPackages;
      src = projectionSource;
    };
  }
  ''
    bun ${projectionSource}/packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts \
      --input ${input} \
      --output "$out" \
      --platform ${platform}
  ''
