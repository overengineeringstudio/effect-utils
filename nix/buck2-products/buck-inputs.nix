# Conservative literal dependency closure, not a recursive copy of buck2/.
# Buck runs with only this projection in the Nix sandbox: a dynamic dependency
# not represented here fails the source-product build rather than reading the
# checkout. Keep the all-products build as the completeness check.
{ lib, repositoryRoot }:
let
  inventories =
    map
      (
        name:
        builtins.fromJSON (builtins.readFile (repositoryRoot + "/nix/buck2-products/${name}-targets.json"))
      )
      [
        "cache"
        "native"
        "compiled"
      ];
  products = lib.concatMap (inventory: inventory.products) inventories;
  targetPackage =
    target: builtins.head (lib.splitString ":" (lib.last (lib.splitString "//" target)));
  seeds = [ "BUCK" ] ++ map (product: "${targetPackage product.target}/BUCK") products;
  # Source closures can contain packages whose rules differ from the entrypoint.
  sourcePaths = lib.unique (lib.concatMap (product: product.sourcePaths or [ ]) products);
  sourceBucks = lib.concatMap (
    path:
    if builtins.pathExists (repositoryRoot + "/${path}") then
      map (file: lib.removePrefix "${toString repositoryRoot}/" (toString file)) (
        lib.fileset.toList (
          lib.fileset.fileFilter (file: file.name == "BUCK") (repositoryRoot + "/${path}")
        )
      )
    else
      [ ]
  ) sourcePaths;
  isTest =
    path:
    lib.hasPrefix "buck2/tests/" path
    || lib.hasInfix "/fixtures/" path
    || lib.hasInfix ".test." path
    || lib.hasSuffix ".genie.ts" path;
  exists =
    path:
    let
      absolute = repositoryRoot + "/${path}";
    in
    builtins.pathExists absolute
    &&
      builtins.getAttr (builtins.baseNameOf absolute) (builtins.readDir (builtins.dirOf absolute))
      != "directory";
  # Starlark labels and export_file names, and helper imports, are literals.
  # Splitting on quoted strings also handles multiline load() declarations.
  literals =
    path:
    if lib.hasSuffix ".json" path then
      [ ]
    else
      let
        # Strip comments in one pass. Splitting every generated BUCK line and
        # then splitting it again at '#' dominates evaluator allocations.
        text = builtins.concatStringsSep "" (
          builtins.filter builtins.isString (
            builtins.split "#[^\n]*" (builtins.readFile (repositoryRoot + "/${path}"))
          )
        );
        # Entrypoint packages also declare tests. Only their rule loads are
        # eager; following every target mentioned in their BUCK would select
        # unrelated test targets, not the product dependency graph.
        pattern =
          if lib.hasPrefix "buck2/" path then
            "[\"']((@rules)?//buck2[^\"']*|[A-Za-z0-9_./@:+-]+\\.(bzl|ts|tsx|mjs|json))[\"']"
          else
            "load\\([[:space:]]*\"([^\"]*)\"";
      in
      lib.concatMap (part: if builtins.isList part then builtins.filter builtins.isString part else [ ]) (
        builtins.split pattern text
      );
  resolve =
    owner: value:
    let
      label = builtins.match "(@rules)?//(buck2[^:]*):(.+)" value;
      relative = lib.removePrefix ":" value;
      local = "${builtins.dirOf owner}/${relative}";
      package = if label == null then null else builtins.elemAt label 1;
      name = if label == null then null else builtins.elemAt label 2;
      file = if label == null then local else "${package}/${name}";
      candidates =
        if label != null then
          (lib.optional (!(lib.hasSuffix ".bzl" name)) "${package}/BUCK") ++ [ file ]
        else if lib.hasPrefix "//buck2/" value && lib.hasSuffix ".bzl" value then
          [ (lib.removePrefix "//" value) ]
        else if
          lib.hasPrefix "buck2/" owner
          && builtins.match "[A-Za-z0-9_./@:+-]+\\.(bzl|ts|tsx|mjs|json)" value != null
        then
          [ file ]
        else
          [ ];
    in
    map (
      path: lib.removePrefix "${toString repositoryRoot}/" (toString (repositoryRoot + "/${path}"))
    ) (builtins.filter (path: lib.hasPrefix "buck2/" path && exists path) candidates);
  closure = builtins.genericClosure {
    startSet = map (key: { inherit key; }) (lib.unique (seeds ++ sourceBucks));
    operator =
      item:
      map (key: { inherit key; }) (lib.unique (lib.concatMap (resolve item.key) (literals item.key)));
  };
  paths = builtins.filter (path: lib.hasPrefix "buck2/" path) (map (item: item.key) closure);
  forbidden = builtins.filter isTest paths;
in
assert lib.assertMsg (
  forbidden == [ ]
) "buck2-products: product rules reference test inputs: ${lib.concatStringsSep ", " forbidden}";
map (path: repositoryRoot + "/${path}") paths
