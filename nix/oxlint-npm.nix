# Package npm oxlint with NAPI bindings to enable JavaScript plugin support.
#
# The Nix-native oxlint binary (pkgs.oxlint) is compiled from Rust and cannot
# execute JS plugins. The npm version uses NAPI bindings to run Rust code from
# a JS runtime (Bun), enabling jsPlugins support.
#
# The two @overeng/oxc-config plugin entry points are imported from the tracked
# immutable Buck product manifest and exposed as stable passthru paths. Nix
# remains only the oxlint runtime packager; it does not rebuild plugin sources.
#
# Usage:
#   pnpmArchives = import ./buck2-products/pnpm-archives.nix { inherit pkgs; };
#   products = repoFlake.buckProducts.${pkgs.stdenv.hostPlatform.system}.products;
#   oxlintNpm = import ./oxlint-npm.nix {
#     inherit pkgs bun pnpmArchives products;
#   };
#   # => oxlintNpm.pluginPath is the overeng plugin module
#   # => oxlintNpm.stylexUpstreamPluginPath is the @stylexjs plugin module
#
# The package version and archive digests are generated from package.json,
# pnpm-lock.yaml, and buck2/dependencies/pnpm-lock.sha256.json. There are no
# independently maintained fetch hashes in this module.
#
# =============================================================================
{
  pkgs,
  bun,
  pnpmArchives,
  products,
}:
let
  lib = pkgs.lib;

  package = builtins.fromJSON (builtins.readFile (../packages + "/@overeng/oxc-config/package.json"));
  version =
    package.devDependencies.oxlint
      or (throw "oxlint-npm: packages/@overeng/oxc-config/package.json does not declare oxlint");
  archiveFor =
    packageIdentity:
    pnpmArchives.archivesByIdentity.${packageIdentity}
      or (throw "oxlint-npm: missing reviewed pnpm archive ${packageIdentity}");

  # Platform-specific package mapping (NAPI binding packages, `@oxlint/binding-*`)
  platformPackages = {
    "aarch64-darwin".name = "@oxlint/binding-darwin-arm64";
    "x86_64-darwin".name = "@oxlint/binding-darwin-x64";
    "x86_64-linux".name = "@oxlint/binding-linux-x64-gnu";
    "aarch64-linux".name = "@oxlint/binding-linux-arm64-gnu";
  };

  system = pkgs.stdenv.hostPlatform.system;
  platformPkg = platformPackages.${system} or (throw "Unsupported platform: ${system}");

  mainPackage = archiveFor "oxlint@${version}";
  binaryPackage = archiveFor "${platformPkg.name}@${version}";

  importProduct = import ./workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };
  importPlugin =
    productName:
    let
      product = products.${productName};
    in
    importProduct {
      inherit (product)
        artifact
        descriptor
        descriptorContent
        expectedDescriptorSha256
        expectedModuleSha256
        ;
      expectedProductKind = "module";
      expectedProductName = productName;
      generateCompletions = false;
    };
  overengPlugin = importPlugin "oxc-config";
  stylexUpstreamPlugin = importPlugin "oxc-config-stylex-upstream-plugin";
  overengPluginModule = "${overengPlugin}/libexec/${overengPlugin.checkedDescriptor.modulePath}";
  stylexUpstreamPluginModule = "${stylexUpstreamPlugin}/libexec/${stylexUpstreamPlugin.checkedDescriptor.modulePath}";

in
pkgs.stdenv.mkDerivation (finalAttrs: {
  pname = "oxlint-npm";
  inherit version;

  dontUnpack = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  buildPhase = ''
    runHook preBuild

    # Create node_modules structure
    mkdir -p $out/lib/node_modules/oxlint
    mkdir -p $out/lib/node_modules/${platformPkg.name}
    mkdir -p $out/bin

    # Extract main oxlint package
    tar -xzf ${mainPackage} -C $out/lib/node_modules/oxlint --strip-components=1

    # Extract platform-specific binary package
    tar -xzf ${binaryPackage} -C $out/lib/node_modules/${platformPkg.name} --strip-components=1

    # Keep both independently attested modules in the oxlint closure and expose
    # stable package-local paths to wrapper consumers.
    ln -s ${overengPluginModule} "$out/lib/oxc-config-plugin.js"
    ln -s ${stylexUpstreamPluginModule} "$out/lib/stylex-upstream-plugin.js"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Create wrapper script that sets up NODE_PATH (Bun uses NODE_PATH for module resolution)
    makeWrapper ${bun}/bin/bun $out/bin/oxlint \
      --add-flags "$out/lib/node_modules/oxlint/bin/oxlint" \
      --set NODE_PATH "$out/lib/node_modules"

    runHook postInstall
  '';

  passthru = {
    pluginPath = "${finalAttrs.finalPackage}/lib/oxc-config-plugin.js";
    stylexUpstreamPluginPath = "${finalAttrs.finalPackage}/lib/stylex-upstream-plugin.js";
    inherit overengPlugin stylexUpstreamPlugin;
  };

  meta = with pkgs.lib; {
    description = "npm oxlint with NAPI bindings for JavaScript plugin support";
    homepage = "https://oxc.rs/docs/guide/usage/linter.html";
    license = licenses.mit;
    mainProgram = "oxlint";
    platforms = builtins.attrNames platformPackages;
  };
})
