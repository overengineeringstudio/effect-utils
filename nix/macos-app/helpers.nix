# Copy pinned native bytes into the bundle; seal-host signs this explicit inventory.
# Scripts/store symlinks are not executable nested code and are rejected here.
{
  pkgs,
  bundleId,
  signer,
  helpers,
}:
let
  inherit (pkgs) lib;
  entries = lib.mapAttrsToList (
    id: helper:
    let
      identifier = helper.identifier or "${bundleId}.helper.${id}";
      requirement =
        helper.requirement
          or ''identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"'';
    in
    assert builtins.match "[a-z][a-z0-9-]*" id != null;
    assert builtins.stringLength id <= 128;
    assert lib.hasPrefix "/nix/store/" (toString helper.executable);
    assert lib.all (
      key:
      builtins.elem key [
        "executable"
        "identifier"
        "requirement"
        "entitlements"
        "signingOptions"
      ]
    ) (builtins.attrNames helper);
    {
      path = "Contents/Helpers/${id}";
      executable = toString helper.executable;
      inherit identifier requirement;
      entitlements = helper.entitlements or null;
      options = helper.signingOptions or [ "runtime" ];
    }
  ) helpers;
in
{
  nestedCode = map (entry: builtins.removeAttrs entry [ "executable" ]) entries;
  requirements = builtins.listToAttrs (
    map (entry: {
      name = entry.path;
      value = entry.requirement;
    }) entries
  );
  copy = lib.concatMapStringsSep "\n" (entry: ''
    test ! -L "$app/Contents"
    test ! -L "$app/Contents/Helpers"
    test ! -e "$app/${entry.path}" && test ! -L "$app/${entry.path}"
    mkdir -p "$app/Contents/Helpers"
    cp -L ${lib.escapeShellArg entry.executable} "$app/${entry.path}"
    chmod 755 "$app/${entry.path}"
    # Validate actual Mach-O bytes, not a script invoking a store interpreter.
    ${pkgs.python3}/bin/python3 - "$app/${entry.path}" <<'PY'
    import pathlib, sys
    path = pathlib.Path(sys.argv[1])
    with path.open('rb') as source:
        magic = source.read(4)
    if path.is_symlink() or magic not in (b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'):
        raise SystemExit('nested helper must be a regular Mach-O executable: ' + str(path))
    PY
  '') entries;
}
