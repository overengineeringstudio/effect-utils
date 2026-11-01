# Public assembly only: no signing, installation, launchd activation or grants.
# Policy files are read at evaluation time and enter the Nix store. Do not put
# secrets in them. Later files shallowly override earlier top-level fields:
# nested objects and lists are replaced wholesale, not recursively merged.
{ pkgs, nixpkgsRevision }:
{
  bundleId,
  displayName,
  signer,
  policyFiles,
  helpers ? { },
  enableExampleChildren ? false,
  guiLaunchd ? {
    label = "${bundleId}.gui";
  },
  name ? "macos-permissions-host",
  enabledGrants ? [
    "full-disk-access"
    "notifications"
    "screen-recording"
    "accessibility"
    "system-audio"
    "microphone"
    "automation"
  ],
  automationTargets ? [ ],
  launchd ? {
    label = bundleId;
  },
  requirement ? ''identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"'',
}:
let
  inherit (pkgs) lib;
  helperAssembly = import ../macos-app/helpers.nix {
    inherit
      pkgs
      bundleId
      signer
      helpers
      ;
  };
  grantCategories = [
    "full-disk-access"
    "notifications"
    "screen-recording"
    "accessibility"
    "system-audio"
    "microphone"
    "automation"
  ];
  enabled = category: builtins.elem category enabledGrants;
  consumerPolicy = lib.foldl' (
    policy: file: policy // builtins.fromJSON (builtins.readFile file)
  ) { } policyFiles;
  # Assembly controls grant/target declarations so Info.plist, entitlements and
  # the runtime policy cannot accidentally disagree through a policy override.
  policyData = consumerPolicy // {
    inherit enabledGrants automationTargets;
    helperRequirements = helperAssembly.requirements;
    hostRequirement = requirement;
    jobProcessTypes = {
      none = launchd.extra.ProcessType or "Background";
      gui = guiLaunchd.extra.ProcessType or "Background";
    };
  };
  policy = pkgs.writeText "${name}-policy.json" (builtins.toJSON policyData);
  # Security identity is sealed bundle data, never an invocation's --config.
  runtimeIdentityData = {
    version = 1;
    targetUid = policyData.uid;
    supervisorLabel = launchd.label;
    guiLabel = guiLaunchd.label;
    hostRequirement = requirement;
  };
  runtimeIdentity = pkgs.writeText "${name}-runtime-identity.json" (
    builtins.toJSON runtimeIdentityData
  );
  # ctl compares Info.plist metadata as well as compiled source bytes. Bind the
  # sealed policy, entitlement and runtime-identity bytes so data-only upgrades install.
  bundlePolicyHash = builtins.hashString "sha256" (
    builtins.toJSON policyData + "\n" + entitlementsXml + "\n" + builtins.toJSON runtimeIdentityData
  );
  source = lib.fileset.toSource {
    # Preserve the relative Cargo path dependency ../../macos-app/host.
    root = ../.;
    fileset = lib.fileset.unions [
      ./host/Cargo.toml
      ./host/Cargo.lock
      ./host/src
      (lib.fileset.maybeMissing ./host/build.rs)
      ../macos-app/host/Cargo.toml
      ../macos-app/host/Cargo.lock
      ../macos-app/host/src
      ../macos-app/children.schema.json
    ];
  };
  # Hash every compiled input, including source paths and the dependency lock.
  # Recursive traversal handles native modules in subdirectories as well.
  sourceContents =
    directory:
    lib.concatMapStrings (
      entry:
      let
        path = directory + "/${entry}";
        kind = (builtins.readDir directory).${entry};
      in
      if kind == "directory" then
        entry + "/\n" + sourceContents path
      else if kind == "regular" then
        entry + "\n" + builtins.readFile path + "\n"
      else
        throw "permissions-host: compiled source must contain only regular files and directories"
    ) (builtins.attrNames (builtins.readDir directory));
  hostSourceHash = builtins.hashString "sha256" (
    sourceContents source + builtins.toJSON { inherit enableExampleChildren; }
  );
  darwinRust = import ../workspace-tools/lib/buck2-darwin-rust-capability.nix {
    inherit pkgs nixpkgsRevision;
  };
  runtime = pkgs.rustPlatform.buildRustPackage {
    pname = "macos-permissions-host";
    version = "1";
    src = source;
    sourceRoot = "source/permissions-host/host";
    cargoLock.lockFile = ./host/Cargo.lock;
    cargoBuildFlags = [
      "--bin"
      "macos-permissions-host"
    ]
    ++ lib.optionals enableExampleChildren [
      "--features"
      "example-children"
    ];
    nativeBuildInputs = [ pkgs.swift ];
    buildInputs = [ pkgs.apple-sdk_15 ];
    # Reuse the capability's pure SDK environment, NOT its compiler wrapper:
    # that wrapper signs outputs after ABI normalization. This assembly must not.
    env = darwinRust.compileEnv // {
      HOST_SOURCE_HASH = hostSourceHash;
      RUSTC = "${pkgs.rustc}/bin/rustc";
      CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER = "${pkgs.clang}/bin/clang";
      CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER = "${pkgs.clang}/bin/clang";
      RUSTFLAGS = lib.concatStringsSep " " [
        "-C link-arg=-isysroot"
        "-C link-arg=${pkgs.apple-sdk_15.sdkroot}"
        "-C link-arg=-L${pkgs.libiconv}/lib"
        "-C link-arg=-Wl,-no_adhoc_codesign"
      ];
    };
    doCheck = false;
    dontStrip = true;
    dontAutoSignDarwinBinaries = true;
    postInstall = ''
      mkdir -p "$out/lib"
      library=$(find target -name libpermissions_onboarding.dylib -print -quit)
      test -n "$library"
      cp "$library" "$out/lib/"
    '';
    postFixup = ''
      ${pkgs.darwin.cctools}/bin/install_name_tool \
        -change '${pkgs.libiconv}/lib/libiconv.2.dylib' /usr/lib/libiconv.2.dylib \
        "$out/bin/macos-permissions-host"
    '';
    meta = {
      mainProgram = "macos-permissions-host";
      platforms = lib.platforms.darwin;
    };
  };
  infoPlistData = {
    CFBundleIdentifier = bundleId;
    CFBundleDisplayName = displayName;
    CFBundleName = displayName;
    CFBundleExecutable = "macos-permissions-host";
    CFBundlePackageType = "APPL";
    CFBundleVersion = "1";
    CFBundleShortVersionString = "1";
    LSUIElement = true;
    LSMinimumSystemVersion = darwinRust.compileEnv.MACOSX_DEPLOYMENT_TARGET;
    MacPermissionsHostPolicyHash = bundlePolicyHash;
  }
  # FDA has no universal usage key or entitlement. This describes the
  # bounded Documents operation, not an automatic Full Disk Access grant.
  // lib.optionalAttrs (enabled "full-disk-access") {
    NSDocumentsFolderUsageDescription = "${displayName} copies explicitly allowlisted Documents files on your behalf.";
  }
  // lib.optionalAttrs (enabled "screen-recording") {
    NSScreenCaptureUsageDescription = "${displayName} captures screen content only for enabled, explicitly requested operations.";
  }
  // lib.optionalAttrs (enabled "system-audio") {
    NSAudioCaptureUsageDescription = "${displayName} captures system audio only for enabled, explicitly requested operations.";
  }
  // lib.optionalAttrs (enabled "microphone") {
    NSMicrophoneUsageDescription = "${displayName} accesses the microphone only for enabled, explicitly requested operations.";
  }
  // lib.optionalAttrs (enabled "automation") {
    NSAppleEventsUsageDescription = "${displayName} controls only the applications explicitly allowed by its Automation policy.";
  }
  # Notifications and Accessibility use their native authorization APIs;
  # neither has a general-purpose Info.plist usage-description requirement.
  ;
  infoPlist = pkgs.writeText "${name}-Info.plist" (
    lib.generators.toPlist { escape = true; } infoPlistData
  );
  entitlementsXml = lib.generators.toPlist { escape = true; } (
    lib.optionalAttrs (enabled "microphone") {
      "com.apple.security.device.audio-input" = true;
    }
    // lib.optionalAttrs (enabled "automation") {
      "com.apple.security.automation.apple-events" = true;
    }
    # No sandbox: FDA, Notifications, Screen Recording, system-audio process
    # taps and Accessibility have no general hardened-runtime entitlement
    # that grants permission. Audio-input is for microphone input, not taps.
  );
  entitlements = pkgs.writeText "${name}-entitlements.plist" entitlementsXml;
  bundle = pkgs.runCommand "${name}-native-bundle" { } ''
    app="$out/${name}.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    ${helperAssembly.copy}
    cp '${runtime}/bin/macos-permissions-host' "$app/Contents/MacOS/macos-permissions-host"
    mkdir -p "$app/Contents/Frameworks"
    cp '${runtime}/lib/libpermissions_onboarding.dylib' "$app/Contents/Frameworks/"
    cp '${infoPlist}' "$app/Contents/Info.plist"
    cp '${policy}' "$app/Contents/Resources/policy.json"
    cp '${runtimeIdentity}' "$app/Contents/Resources/runtime-identity.json"
    cp '${entitlements}' "$app/Contents/Resources/entitlements.plist"
    printf '%s\n' '${hostSourceHash}' > "$app/Contents/Resources/host-source-hash"
  '';
  assembly = import ../macos-app { inherit pkgs nixpkgsRevision; } {
    inherit
      name
      bundleId
      displayName
      signer
      requirement
      ;
    launchd = launchd // {
      extra = {
        ProcessType = "Background";
      }
      // (launchd.extra or { });
    };
    guiLaunchd = guiLaunchd // {
      extra = {
        ProcessType = "Background";
      }
      // (guiLaunchd.extra or { });
    };
    actions = { };
    supervisedChildren = policyData.supervisedChildren or [ ];
    statusAllowedUids = [ policyData.uid ];
    socketMode = 384; # 0600; the native host independently checks peer UIDs.
    session = "system-daemon";
    targetUid = policyData.uid;
    inherit (policyData) policyRevision releaseRevision;
    hostBundle = {
      path = "${bundle}/${name}.app";
      executable = "Contents/MacOS/macos-permissions-host";
      inherit hostSourceHash entitlements;
      nestedCode = helperAssembly.nestedCode ++ [
        {
          path = "Contents/Frameworks/libpermissions_onboarding.dylib";
          identifier = "${bundleId}.onboarding";
          requirement = ''identifier "${bundleId}.onboarding" and anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"'';
          entitlements = null;
          options = [ "runtime" ];
        }
      ];
      signingOptions = [ "runtime" ];
    };
  };
in
assert lib.assertMsg pkgs.stdenv.hostPlatform.isDarwin "permissions-host requires Darwin";
assert lib.assertMsg (displayName != "") "permissions-host requires a consent-facing displayName";
assert lib.assertMsg (policyFiles != [ ]) "permissions-host requires consumer policy files";
assert lib.assertMsg (
  lib.all (category: builtins.elem category grantCategories) enabledGrants
  && builtins.length enabledGrants == builtins.length (lib.unique enabledGrants)
) "permissions-host enabledGrants must be unique known categories";
assert lib.assertMsg (
  lib.all (
    target: builtins.isString target && builtins.match "[A-Za-z0-9.-]+" target != null
  ) automationTargets
  && builtins.length automationTargets == builtins.length (lib.unique automationTargets)
) "permissions-host automationTargets must be unique bundle identifiers";
assert lib.assertMsg (lib.all (child: builtins.hasAttr child.helperPath helperAssembly.requirements)
  (policyData.supervisedChildren or [ ])
) "permissions-host supervised children must reference an assembled native helper";
assert lib.assertMsg (lib.all
  (child: lib.all (service: builtins.elem service enabledGrants) child.requiredTccServices)
  (policyData.supervisedChildren or [ ])
) "permissions-host child requires a disabled grant category";
assert lib.assertMsg (lib.all
  (
    child:
    (
      child.readiness.kind != "probe-op"
      || (
        enableExampleChildren && child.readiness.op == "example.ready" && child.requiresSession == "none"
      )
    )
    && (
      child.schedule.kind != "launchd-scheduled"
      || (
        enableExampleChildren
        && child.schedule.op == "example.run"
        && child.id == "headless-worker"
        && child.requiresSession == "none"
      )
    )
  )
  (policyData.supervisedChildren or [ ])
) "permissions-host child operation is absent from the compiled product registry";
{
  inherit
    runtime
    policy
    infoPlist
    infoPlistData
    entitlements
    hostSourceHash
    bundlePolicyHash
    ;
  # Preserve the normal mkMacosApp lifecycle interface. hostApp alone stays
  # unsigned; ctl, primitives and desiredDescriptor lazily depend on the existing
  # genericHost tooling derivation, whose postFixup ad-hoc signs its own binaries.
  # Those tools do not sign this app until the consumer explicitly seals it.
  inherit (assembly)
    hostApp
    hostAppBundle
    appBundleName
    requirement
    ctl
    ctlConfig
    generation
    desiredDescriptor
    primitives
    ;
}
