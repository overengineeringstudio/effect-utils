# TOOL identity selection only. Check-source digests remain Buck action inputs.
{
  pkgs,
  repositoryRoot,
  stage0Tools,
  publicationOwner,
  editorViewLease,
  retainedToolNames,
}:
let
  lib = pkgs.lib;
  relative = file: lib.removePrefix "${toString repositoryRoot}/" (toString file);
  inventory = lib.concatMap (name:
    (builtins.fromJSON (builtins.readFile (./buck2-products + "/${name}-targets.json"))).products
  ) [ "cache" "native" "compiled" ];
  # The caller reuses its admitted shell/task product inventory. Extra names
  # here are runtime products pulled in by those wrappers and task launchers.
  productNames = retainedToolNames ++ [
    "oxc-config" "oxc-config-stylex-upstream-plugin"
    "notion-md" "notion-db-runtime" "genie-bootstrap-closure-check"
    "worktree-lease"
  ];
  products = builtins.filter (product: builtins.elem product.name productNames) inventory;
  # Reuse the product root's authoritative input declaration and its existing
  # buck-inputs test guard. Do not add a second test-exclusion convention here.
  rootInputs = import ./buck2-products/root-projection-inputs.nix {
    inherit pkgs repositoryRoot;
  };
  stage0Names = [ "events" "archive-tool" "product" "fingerprint" ];
  manifestNames = [ "package.json" "pnpm-lock.yaml" "Cargo.toml" "Cargo.lock" ];
  # One declaration drives both Git selectors and the immutable byte projection.
  literals =
    rootInputs
    ++ lib.concatMap (product: product.sourcePaths) products
    ++ map relative (import ./buck2-launcher-inputs.nix)
    ++ map relative publicationOwner.source-inputs
    ++ [ (relative editorViewLease.src) ]
    ++ map relative (builtins.attrValues (import ./task-authority-inputs.nix {
      inherit repositoryRoot;
    }))
    ++ [
      "flake.nix"
      "flake.lock"
      "nix"
      "devenv.nix"
      "devenv.yaml"
      "devenv.lock"
      "buck2-member.json"
      "scripts/worktree-env.py"
      "scripts/buck2-capability-publish.ts"
      "packages/@overeng/buck2-tools/src/editor-publication-owner.ts"
      "packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts"
      "pnpm-workspace.yaml"
      "pnpm-lock.yaml"
      "megarepo.kdl"
      "megarepo.lock"
    ];
in
{
  paths =
    literals
    ++ lib.concatMap (name: stage0Tools.source-pathspecs.${name}) stage0Names
    ++ map (name: ":(glob)**/${name}") manifestNames;
  source = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions (
      map (path: repositoryRoot + "/${path}") literals
      ++ lib.concatMap (name: stage0Tools.source-inputs.${name}) stage0Names
      ++ [
        (lib.fileset.fileFilter (file: builtins.elem file.name manifestNames) repositoryRoot)
      ]
    );
  };
}
