# Generic host bytes depend only on host/, its version and the pinned toolchain.
# Product identity lives in Info.plist; payloads and policy live in the generation.
# signer declares an identity string, never key material; signing happens at activation.
# args are ordered { name, kind = "enum"|"string"|"integer", ... } declarations.
# All arguments are required; no shell interpolation or generic exec is exposed.
{ pkgs, nixpkgsRevision }:
{
  name,
  bundleId,
  displayName,
  actions,
  statusAllowedUids,
  host ? null,
  session ? "background-agent",
  launchd,
  signer,
  socketMode ? 438, # 0666: reachability is separate from peer-UID authorization.
}:
let
  # Only owner/group/world read-write modes are supported; never executable sockets.
  inherit (pkgs) lib;
  genericHostSourceHash = builtins.hashString "sha256" (
    builtins.readFile ./host/src/main.rs
    + builtins.readFile ./host/Cargo.toml
    + builtins.readFile ./host/Cargo.lock
  );
  # Custom hosts declare the product-independent hash they report via wire status.
  hostSourceHash = if host == null then genericHostSourceHash else host.hostSourceHash;
  hostExecutable = if host == null then "macos-app-host" else builtins.baseNameOf (lib.getExe host);
  hostPath = if host == null then "${genericHost}/bin/macos-app-host" else lib.getExe host;
  requirement = ''identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"'';
  launchdData = {
    inherit (launchd) label;
    keepAlive = launchd.keepAlive or true;
    runAtLoad = launchd.runAtLoad or true;
  }
  // (launchd.extra or { });
  ctlConfig = pkgs.writeText "${name}-ctl.json" (
    builtins.toJSON {
      inherit
        bundleId
        session
        hostExecutable
        requirement
        signer
        ;
      launchd = launchdData;
    }
  );
  # The password reaches ctl only through the consumer's --keychain-password-fd descriptor.
  ctl = pkgs.writeShellScriptBin "macos-app-ctl" ''
    exec '${genericHost}/bin/macos-app-ctl' "$@" --config '${ctlConfig}'
  '';
  darwinRust = import ../workspace-tools/lib/buck2-darwin-rust-capability.nix {
    inherit pkgs nixpkgsRevision;
  };
  # nixpkgs Swift 5.10 cannot import apple-sdk_15.5's Darwin/Foundation headers.
  # Rust reuses the existing pure SDK capability; no system Xcode is consulted.
  genericHost = pkgs.rustPlatform.buildRustPackage {
    pname = "macos-app-host";
    version = "1";
    src = ./host;
    cargoLock.lockFile = ./host/Cargo.lock;
    buildInputs = [ pkgs.apple-sdk_15 ];
    env = darwinRust.compileEnv // {
      HOST_SOURCE_HASH = genericHostSourceHash;
      RUSTC = "${darwinRust.compiler}/bin/rustc";
    };
    doCheck = true;
    # Cargo uses --out-dir, so the capability's -o-specific ABI normalization
    # must also run on the installed executable, after stripping.
    postFixup = ''
      for binary in macos-app-host macos-app-ctl macos-app-launchd-smoke; do
        if [[ ! -f "$out/bin/$binary" ]]; then continue; fi
        ${pkgs.darwin.cctools}/bin/install_name_tool \
          -change '${pkgs.libiconv}/lib/libiconv.2.dylib' /usr/lib/libiconv.2.dylib \
          "$out/bin/$binary"
        source ${pkgs.darwin.signingUtils}
        sign "$out/bin/$binary"
      done
    '';
  };
  actionData = lib.mapAttrs (
    actionName: action:
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
    }
  ) actions;
  manifestInput = pkgs.writeText "macos-app-manifest-input.json" (
    builtins.toJSON {
      manifestVersion = 1;
      actions = actionData;
      inherit statusAllowedUids socketMode;
    }
  );
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
  plist = pkgs.writeText "Info.plist" (
    lib.generators.toPlist { escape = true; } {
      CFBundleIdentifier = bundleId;
      CFBundleDisplayName = displayName;
      CFBundleName = displayName;
      CFBundleExecutable = hostExecutable;
      CFBundlePackageType = "APPL";
      CFBundleVersion = "1";
      LSBackgroundOnly = session != "gui-agent";
    }
  );
in
assert pkgs.stdenv.hostPlatform.isDarwin;
assert builtins.match "[A-Za-z0-9._-]+" name != null;
assert builtins.match "[A-Za-z0-9.-]+" bundleId != null;
assert builtins.match "[A-Z0-9]+" signer.teamId != null;
assert signer.identity != "" && signer.identity != "-";
assert builtins.elem session [
  "gui-agent"
  "background-agent"
  "system-daemon"
];
assert builtins.match "[A-Za-z0-9.-]+" launchd.label != null;
assert lib.all (
  key:
  builtins.elem key [
    "AssociatedBundleIdentifiers"
    "ProcessType"
    "ThrottleInterval"
    "StandardOutPath"
    "StandardErrorPath"
    "WorkingDirectory"
    "Umask"
  ]
) (builtins.attrNames (launchd.extra or { }));
assert builtins.elem socketMode [
  384
  432
  438
]; # 0600, 0660, 0666
{
  inherit
    generation
    hostSourceHash
    requirement
    ctl
    ctlConfig
    ;
  # Unwrapped host + ctl binaries; its build runs the crate's unit tests.
  primitives = genericHost;
  hostApp = pkgs.runCommand "${name}-unsigned-app" { } ''
    mkdir -p "$out/${name}.app/Contents/MacOS"
    mkdir -p "$out/${name}.app/Contents/Resources"
    cp '${hostPath}' "$out/${name}.app/Contents/MacOS/${hostExecutable}"
    printf '%s\n' '${hostSourceHash}' > "$out/${name}.app/Contents/Resources/host-source-hash"
    cp '${plist}' "$out/${name}.app/Contents/Info.plist"
  '';
}
