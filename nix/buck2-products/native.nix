# Native products for the evaluating host platform. Rust products use the
# pinned Cargo archive projection; the TypeScript API server uses pnpm archives.
# Every product is independently realized and validated by importNative.
args@{
  pkgs,
  mkBuckProductFromSource,
  capabilities,
  pnpmArchives,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./native-targets.json);
  # Native shell products are source-addressed, not HEAD-addressed. Keep the
  # ordinary repository Buck root as a separate, declared rules input; package
  # source closures come from the committed Genie inventory below.
  rootProjection = import ./root-projection.nix { inherit pkgs repositoryRoot; };
  cargoArchives = import ../workspace-tools/lib/buck2-cargo-archives.nix {
    inherit pkgs;
    thirdPartyBuckFiles = [ (repositoryRoot + "/rust/third-party/BUCK") ];
  };
  validProduct =
    product:
    builtins.isAttrs product
    &&
      builtins.attrNames product == (
        [ "buildCapabilities" ]
        ++ pkgs.lib.optional (product ? cargoWorkspaceRoot) "cargoWorkspaceRoot"
        ++ [
          "kind"
          "linuxBuildCapabilities"
          "name"
          "outputName"
        ]
        ++ pkgs.lib.optional (product ? shellCompletions) "shellCompletions"
        ++ [
          "sourcePaths"
          "target"
          "version"
        ]
      )
    && builtins.elem product.kind [
      "native"
      "rust-library"
    ]
    && builtins.isString product.name
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" product.name != null
    && product.outputName == "artifact.tar"
    && builtins.isString product.target
    &&
      builtins.match "effect_utils//(packages/@overeng|rust)/[A-Za-z0-9._-]+:[A-Za-z0-9._+-]+" product.target
      != null
    && builtins.isString product.version
    && product.version != ""
    && (
      !(product ? cargoWorkspaceRoot)
      || (builtins.isString product.cargoWorkspaceRoot && product.cargoWorkspaceRoot == "rust")
    )
    && (
      !(product ? shellCompletions)
      || (product ? cargoWorkspaceRoot && builtins.isBool product.shellCompletions)
    );
  names = map (product: product.name) inventory.products;
  targets = map (product: product.target) inventory.products;
in
assert
  builtins.attrNames inventory == [
    "products"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck-native-targets/v1"
  && inventory.schemaVersion == 1
  && builtins.isList inventory.products
  && builtins.all validProduct inventory.products
  && builtins.length names == builtins.length (pkgs.lib.unique names)
  && builtins.length targets == builtins.length (pkgs.lib.unique targets)
  || throw "buck2-products: generated native target inventory is invalid";
builtins.listToAttrs (
  map (product: {
    inherit (product) name;
    value =
      let
        nativeProduct = mkBuckProductFromSource {
          inherit
            pnpmArchives
            product
            repositoryRoot
            rootProjection
            ;
          capabilities = capabilities.selectProduct product;
          sourcePaths = product.sourcePaths;
          # producerCommit is deliberately absent: unrelated commits must keep the
          # exact source product and its validated native import substitutable.
          cargoArchives = if product ? cargoWorkspaceRoot then cargoArchives else null;
          importNative = true;
          # The platform TypeScript server is fully static on Linux; Rust CLIs
          # and the Darwin server use the dynamic runtime inspector.
          runtimeKind =
            if product.name == "typescript-api-server" && pkgs.stdenv.hostPlatform.isLinux then
              "elf-static"
            else
              null;
        };
      in
      if product.name == "worktree-lease" then
        pkgs.runCommand "worktree-lease-with-compat" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
          mkdir -p "$out/bin" "$out/share/worktree-lease"
          ln -s ${nativeProduct}/bin/worktree-lease "$out/bin/worktree-lease"
          cp ${repositoryRoot + "/rust/worktree-lease/compat"}/*.py "$out/share/worktree-lease/"
          ln -s reclaim_worktree_guard.py "$out/share/worktree-lease/reclaim-worktree-guard.py"
          ln -s gate_worktree_lease.py "$out/share/worktree-lease/gate-worktree-lease.py"
          for entry in gate-lease-write:writer_main reclaim-worktree-guard:guard_main; do
            name="''${entry%:*}"; function="''${entry#*:}"
            makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/$name" \
              --add-flags "-c 'import sys; sys.path.insert(0, \"$out/share/worktree-lease\"); from gate_worktree_lease import $function; sys.exit($function())'" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
          done
        ''
      else if product.kind == "rust-library" then
        nativeProduct.overrideAttrs (old: {
          passthru = (old.passthru or { }) // {
            compositionChecks = import ./composition-check.nix {
              inherit pkgs;
              library = nativeProduct;
              tool = (import ./native.nix args).otelite;
            };
            libraryChecks = import ./library-check.nix {
              inherit pkgs;
              product = nativeProduct;
              fixture = mkBuckProductFromSource {
                inherit
                  pnpmArchives
                  repositoryRoot
                  rootProjection
                  cargoArchives
                  ;
                capabilities = capabilities.selectProduct product;
                sourcePaths = product.sourcePaths ++ [ "buck2/tests/library_closure" ];
                product = {
                  name = "example-library";
                  version = "0.0.0";
                  kind = "rust-library";
                  target = "effect_utils//buck2/tests/library_closure:product";
                  outputName = "artifact.tar";
                  cargoWorkspaceRoot = "buck2/tests/library_closure";
                };
                importNative = true;
                admitTestFixtureInputs = true;
              };
            };
          };
        })
      else if product.shellCompletions or false then
        nativeProduct.overrideAttrs (old: {
          nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.installShellFiles ];
          # The validated import is sealed read-only. Add only shell hooks after
          # realization; never wrap the executable, preserving argv[0] aliases.
          buildCommand = old.buildCommand + ''
            chmod u+w "$out"
            if [ -d "$out/share" ]; then chmod -R u+w "$out/share"; fi
            for shell in bash zsh fish; do
              COMPLETE="$shell" "$out/bin/${product.name}" > "$shell.completion"
              # installShellCompletion consumes $1 until shift fails; its API
              # requires nounset disabled. Keep the native builder strict outside it.
              (
                set +u
                installShellCompletion --cmd ${pkgs.lib.escapeShellArg product.name} \
                  "--$shell" "$shell.completion"
              )
            done
            chmod -R a-w "$out/share"
            chmod a-w "$out"
          '';
        })
      else
        nativeProduct;
  }) inventory.products
)
