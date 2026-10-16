# Disposable native fixtures are compiled with the platform SDK by native/build.sh.
# Nothing here executes the host or requests permissions. Signing is a separate ctl step.
{
  pkgs,
  nixpkgsRevision,
  nativeBundle,
  release ? "1",
  signer,
  allowedUid ? 501,
}:
let
  inherit (pkgs) lib;
  bundleId = "dev.overeng.permissions-host.experiment";
  sourceHash = builtins.hashString "sha256" (
    builtins.readFile ./native/Host.swift + builtins.readFile ./native/Client.swift + release
  );
  requirementFor = id: ''identifier "${id}" and anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"'';
  # Workers remain pinned executable bytes. No client-provided argv is accepted.
  bundle = pkgs.runCommand "permissions-host-experiment-${release}-bundle" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    mkdir -p "$out"
    cp -R ${lib.escapeShellArg (toString nativeBundle)} "$out/MacPermissionsHostExperiment.app"
    chmod -R u+w "$out/MacPermissionsHostExperiment.app"
    app="$out/MacPermissionsHostExperiment.app"
    mkdir -p "$app/Contents/Helpers" "$app/Contents/Resources"
    cp '${pkgs.restic}/bin/restic' "$app/Contents/Helpers/restic"
    cp '${pkgs.watchman}/bin/watchman' "$app/Contents/Helpers/watchman"
    printf '%s' '${sourceHash}' > "$app/Contents/Resources/source-hash"
    python3 - "$app" '${release}' <<'PY'
    import hashlib, json, pathlib, plistlib, sys
    app = pathlib.Path(sys.argv[1])
    info = app / 'Contents/Info.plist'
    data = plistlib.loads(info.read_bytes())
    data['CFBundleVersion'] = sys.argv[2]
    info.write_bytes(plistlib.dumps(data))
    helpers = {name: hashlib.sha256((app / 'Contents/Helpers' / name).read_bytes()).hexdigest()
               for name in ('restic', 'watchman')}
    (app / 'Contents/Resources/helpers.json').write_text(json.dumps(helpers) + '\n')
    PY
  '';
  product = (import ../../../../nix/macos-app { inherit pkgs nixpkgsRevision; }) {
    name = "MacPermissionsHostExperiment";
    inherit bundleId signer;
    displayName = "Mac Permissions Host (Experiment)";
    session = "gui-agent";
    launchd.label = bundleId;
    statusAllowedUids = [ allowedUid ];
    socketMode = 384;
    actions = { };
    hostBundle = {
      path = "${bundle}/MacPermissionsHostExperiment.app";
      executable = "Contents/MacOS/permissions-host";
      hostSourceHash = sourceHash;
      signingOptions = [ "runtime" ];
      entitlements = pkgs.writeText "permissions-host-entitlements.plist" (lib.generators.toPlist { } {
        "com.apple.security.automation.apple-events" = true;
        "com.apple.security.device.audio-input" = true;
      });
      nestedCode = map (name: {
        path = "Contents/Helpers/${name}";
        identifier = "${bundleId}.${name}";
        requirement = requirementFor "${bundleId}.${name}";
        options = [ "runtime" ];
      }) [ "restic" "watchman" ];
    };
  };
in product // { inherit bundle; }
