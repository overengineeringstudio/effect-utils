{
  lib,
  repositoryRoot,
  extraEntryTargets ? [ ],
  # Installed-library acceptance alone stages the otherwise forbidden fixture rules.
  admitTestFixtureInputs ? false,
}:
let
  readProducts =
    name:
    (builtins.fromJSON (
      builtins.readFile (repositoryRoot + "/nix/buck2-products/${name}-targets.json")
    )).products;
  products = lib.concatMap readProducts [
    "cache"
    "native"
    "compiled"
  ];
  targetPackage =
    target: builtins.head (lib.splitString ":" (lib.last (lib.splitString "//" target)));
  extraBucks = map (target: "${targetPackage target}/BUCK") extraEntryTargets;
  seeds = [ "BUCK" ] ++ map (product: "${targetPackage product.target}/BUCK") products ++ extraBucks;
  sourcePaths = lib.unique (lib.concatMap (product: product.sourcePaths or [ ]) products);
  sourceBucks = lib.concatMap (
    path:
    map (file: lib.removePrefix "${toString repositoryRoot}/" (toString file)) (
      lib.fileset.toList (
        lib.fileset.fileFilter (file: file.name == "BUCK") (repositoryRoot + "/${path}")
      )
    )
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
  literals =
    path:
    if lib.hasSuffix ".json" path then
      [ ]
    else
      let
        text = builtins.concatStringsSep "" (
          builtins.filter builtins.isString (
            builtins.split "#[^\n]*" (builtins.readFile (repositoryRoot + "/${path}"))
          )
        );
        # Entrypoint BUCKs contribute eager loads, not unrelated test targets.
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
  paths = builtins.filter (path: lib.hasPrefix "buck2/" path || builtins.elem path extraBucks) (
    map (item: item.key) closure
  );
  forbidden = builtins.filter isTest paths;
in
assert lib.assertMsg (
  admitTestFixtureInputs || forbidden == [ ]
) "buck2-products: product rules reference test inputs: ${lib.concatStringsSep ", " forbidden}";
{
  files = map (path: repositoryRoot + "/${path}") paths;
  packages = lib.unique (
    map (item: lib.removeSuffix "/" (lib.removeSuffix "BUCK" item.key)) (
      builtins.filter (item: builtins.baseNameOf item.key == "BUCK") closure
    )
  );
}
