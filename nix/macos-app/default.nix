# Generic host bytes depend only on host/, its version and the pinned toolchain.
# Product identity lives in Info.plist; payloads and policy live in the generation.
# teamId constructs the expected requirement only; no signing identity is used.
# args are ordered { name, kind = "enum"|"string"|"integer", ... } declarations.
# All arguments are required; no shell interpolation or generic exec is exposed.
{ pkgs, nixpkgsRevision }:
{
  name,
  bundleId,
  displayName,
  actions,
  statusAllowedUids,
  teamId,
}:
let
  inherit (pkgs) lib;
  hostSourceHash = builtins.hashString "sha256" (
    builtins.readFile ./host/src/main.rs
    + builtins.readFile ./host/Cargo.toml
    + builtins.readFile ./host/Cargo.lock
  );
  darwinRust = import ../workspace-tools/lib/buck2-darwin-rust-capability.nix {
    inherit pkgs nixpkgsRevision;
  };
  # nixpkgs Swift 5.10 cannot import apple-sdk_15.5's Darwin/Foundation headers.
  # Rust reuses the existing pure SDK capability; no system Xcode is consulted.
  host = pkgs.rustPlatform.buildRustPackage {
    pname = "macos-app-host";
    version = "1";
    src = ./host;
    cargoLock.lockFile = ./host/Cargo.lock;
    buildInputs = [ pkgs.apple-sdk_15 ];
    env = darwinRust.compileEnv // {
      HOST_SOURCE_HASH = hostSourceHash;
      RUSTC = "${darwinRust.compiler}/bin/rustc";
    };
    doCheck = false;
    # Cargo uses --out-dir, so the capability's -o-specific ABI normalization
    # must also run on the installed executable, after stripping.
    postFixup = ''
      ${pkgs.darwin.cctools}/bin/install_name_tool \
        -change '${pkgs.libiconv}/lib/libiconv.2.dylib' /usr/lib/libiconv.2.dylib \
        "$out/bin/macos-app-host"
      source ${pkgs.darwin.signingUtils}
      sign "$out/bin/macos-app-host"
    '';
  };
  actionData = lib.mapAttrs (actionName: action:
    assert actionName != "status";
    assert (action.concurrency or 1) == 1;
    assert action.timeoutMs > 0;
    assert lib.hasPrefix "/nix/store/" (toString action.executable);
    {
      executable = toString action.executable;
      argv = action.argv or [ ];
      args = action.args or [ ];
      allowedUids = action.allowedUids;
      timeoutMs = action.timeoutMs;
      concurrency = 1;
      sha256 = "";
    }) actions;
  manifestInput = pkgs.writeText "macos-app-manifest-input.json" (builtins.toJSON {
    manifestVersion = 1;
    actions = actionData;
    inherit statusAllowedUids;
  });
  generation = pkgs.runCommand "${name}-generation" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    mkdir -p "$out"
    python3 - '${manifestInput}' "$out/manifest.json" <<'PY'
    import hashlib, json, sys
    with open(sys.argv[1]) as f: manifest = json.load(f)
    for action in manifest['actions'].values():
        with open(action['executable'], 'rb') as f:
            action['sha256'] = hashlib.file_digest(f, 'sha256').hexdigest()
    encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    manifest['generation'] = hashlib.sha256(encoded).hexdigest()
    with open(sys.argv[2], 'w') as f: json.dump(manifest, f, sort_keys=True)
    PY
  '';
  plist = pkgs.writeText "Info.plist" (lib.generators.toPlist { escape = true; } {
    CFBundleIdentifier = bundleId;
    CFBundleDisplayName = displayName;
    CFBundleName = displayName;
    CFBundleExecutable = "macos-app-host";
    CFBundlePackageType = "APPL";
    CFBundleVersion = "1";
    LSBackgroundOnly = true;
  });
in
assert pkgs.stdenv.hostPlatform.isDarwin;
assert builtins.match "[A-Za-z0-9._-]+" name != null;
assert builtins.match "[A-Za-z0-9.-]+" bundleId != null;
assert builtins.match "[A-Z0-9]+" teamId != null;
{
  inherit generation hostSourceHash;
  requirement = ''identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"'';
  hostApp = pkgs.runCommand "${name}-unsigned-app" { } ''
    mkdir -p "$out/${name}.app/Contents/MacOS"
    cp '${host}/bin/macos-app-host' "$out/${name}.app/Contents/MacOS/macos-app-host"
    cp '${plist}' "$out/${name}.app/Contents/Info.plist"
  '';
}
