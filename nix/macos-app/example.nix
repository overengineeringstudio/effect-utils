{ pkgs, nixpkgsRevision }:
let
  mkMacosApp = import ./default.nix { inherit pkgs nixpkgsRevision; };
  # A separate permissions-host example exercises the real two-job runtime.
  # Both helpers are native, offline and consent-free; only their session differs.
  childHelper = pkgs.stdenv.mkDerivation {
    pname = "macos-app-example-child";
    version = "1";
    src = ./example-child.c;
    dontUnpack = true;
    dontStrip = true;
    dontAutoSignDarwinBinaries = true;
    buildPhase = ''
      $CC -Wall -Wextra -Werror -Wl,-no_adhoc_codesign "$src" -o example-child
    '';
    installPhase = ''
      mkdir -p "$out/bin"
      cp example-child "$out/bin/example-child"
    '';
  };
  childDeclaration = id: requiresSession: {
    inherit id requiresSession;
    helperPath = "Contents/Helpers/${id}";
    activation = "active";
    argv = [
      (if requiresSession == "none" then "scheduled" else "resident")
      "/private/tmp/dev.example.supervised-host/${id}/run/ready.sock"
    ];
    env = { };
    cwd = "/";
    requiredTccServices = [ ];
    readiness =
      if requiresSession == "none" then
        {
          kind = "probe-op";
          op = "example.ready";
          timeoutMs = 1000;
        }
      else
        { kind = "none"; };
    clientSocket =
      if requiresSession == "none" then
        "/private/tmp/dev.example.supervised-host/${id}/run/ready.sock"
      else
        null;
    restart.kind = "never";
    stop = {
      signal = "term";
      graceMs = 1000;
    };
    schedule =
      if requiresSession == "none" then
        {
          kind = "launchd-scheduled";
          op = "example.run";
        }
      else
        { kind = "resident"; };
    rlimitNofile = {
      soft = 256;
      hard = 256;
    };
    nice = 5;
    processType = "Background";
    directories = builtins.listToAttrs (
      map
        (kind: {
          name = kind;
          value = {
            path = "/private/tmp/dev.example.supervised-host/${id}/${kind}";
            mode = 448;
          };
        })
        [
          "state"
          "run"
          "log"
        ]
    );
  };
  childrenPolicy = pkgs.writeText "supervised-example-policy.json" (
    builtins.toJSON {
      uid = 501; # Set the target user's UID when adapting this example.
      socket = "/private/tmp/dev.example.supervised-host/control.sock";
      audit = "/private/tmp/dev.example.supervised-host/audit.jsonl";
      staging = "/private/tmp/dev.example.supervised-host/staging";
      policyRevision = "1";
      releaseRevision = "1";
      auditMaxBytes = 1048576;
      products = { };
      documents = {
        sources = { };
        maxItems = 1;
        maxBytes = 1024;
        timeoutMs = 1000;
      };
      supervisedChildren = [
        (childDeclaration "headless-worker" "none")
        (childDeclaration "session-worker" "gui")
      ];
    }
  );
  childrenProduct = import ../permissions-host { inherit pkgs nixpkgsRevision; } {
    name = "SupervisedHost";
    bundleId = "dev.example.supervised-host";
    displayName = "Supervised Host";
    signer = {
      teamId = "EXAMPLE123";
      identity = "Example certificate identity (not used by tests)";
    };
    enabledGrants = [ ];
    policyFiles = [ childrenPolicy ];
    enableExampleChildren = true;
    helpers = {
      headless-worker.executable = "${childHelper}/bin/example-child";
      session-worker.executable = "${childHelper}/bin/example-child";
    };
  };
  payload =
    text:
    pkgs.writeShellScript "synthetic-payload" ''
      printf '%s:%s:%s:%s\n' '${text}' "$1" "$2" "$3"
    '';
  product =
    text:
    mkMacosApp {
      name = "SyntheticHost";
      bundleId = "dev.example.synthetic-host";
      displayName = "Synthetic Host";
      signer = {
        teamId = "EXAMPLE123";
        identity = "Example certificate identity (not used by tests)";
      };
      session = "background-agent";
      launchd.label = "dev.example.synthetic-host";
      statusAllowedUids = [ 501 ];
      actions.echo = {
        executable = payload text;
        argv = [ ];
        allowedUids = [ 501 ];
        timeoutMs = 1000;
        concurrency = 1;
        args = [
          {
            name = "choice";
            kind = "enum";
            values = [
              "alpha"
              "beta"
            ];
          }
          {
            name = "text";
            kind = "string";
            maxLength = 20;
            pattern = "[a-z]+";
          }
          {
            name = "count";
            kind = "integer";
            min = 1;
            max = 5;
          }
        ];
      };
      actions.wait = {
        executable = pkgs.writeScript "synthetic-wait" ''
          #!${pkgs.python3}/bin/python3
          import time
          time.sleep(1)
          print('waited')
        '';
        allowedUids = [ 501 ];
        timeoutMs = 2000;
      };
      actions.noisy = {
        executable = pkgs.writeScript "synthetic-noisy" ''
          #!${pkgs.python3}/bin/python3
          import sys
          sys.stdout.buffer.write(bytes([0]) * 20000)
          sys.stderr.buffer.write(bytes([0]) * 20000)
          sys.exit(7)
        '';
        allowedUids = [ 501 ];
        timeoutMs = 2000;
      };
    };
  first = product "first";
  second = product "second";
  # Products own complete bundle construction, including their native helpers.
  completeBundle = pkgs.runCommand "synthetic-complete-bundle" { } ''
    mkdir -p "$out"
    app="$out/SyntheticHost.app"
    cp -R ${pkgs.lib.escapeShellArg first.hostAppBundle} "$app"
    chmod -R u+w "$app"
    mkdir -p "$app/Contents/Helpers"
    cp '${first.primitives}/bin/macos-app-host' \
      "$app/Contents/Helpers/synthetic-helper"
  '';
  completeProduct = mkMacosApp {
    name = "SyntheticHost";
    bundleId = "dev.example.synthetic-host";
    displayName = "Synthetic Host";
    # An incumbent's predicate is pinned verbatim, not replaced by the team default.
    requirement = ''identifier "dev.example.synthetic-host" and anchor apple generic and certificate leaf[subject.CN] = "Example certificate identity (not used by tests)"'';
    signer = {
      teamId = "EXAMPLE123";
      identity = "Example certificate identity (not used by tests)";
    };
    hostBundle = {
      path = "${completeBundle}/SyntheticHost.app";
      executable = "Contents/MacOS/macos-app-host";
      hostSourceHash = first.hostSourceHash;
      signingOptions = [ "runtime" ];
      nestedCode = [
        {
          path = "Contents/Helpers/synthetic-helper";
          identifier = "dev.example.synthetic-host.helper";
          requirement = ''identifier "dev.example.synthetic-host.helper" and anchor apple generic and certificate leaf[subject.CN] = "Example certificate identity (not used by tests)"'';
          options = [ "runtime" ];
        }
      ];
    };
    launchd.label = "dev.example.synthetic-host";
    statusAllowedUids = [ 501 ];
    actions = { };
  };
  tampered = pkgs.runCommand "synthetic-tampered-payload" { } ''
    mkdir -p "$out"
    cp '${payload "first"}' "$out/payload"
    chmod u+w "$out/payload"
    printf '# tampered bytes\n' >> "$out/payload"
  '';
  # Test-only issuance stays outside the shipped primitives and host app.
  testPrimitives = first.primitives.overrideAttrs (old: {
    pname = "macos-app-test-primitives";
    cargoBuildFlags = [ "--features=test-signing-cert" ];
    cargoTestFlags = [ "--features=test-signing-cert" ];
    # Feature-built checks resolve codesign through PATH, just like the integration runner.
    nativeCheckInputs = (old.nativeCheckInputs or [ ]) ++ [
      (pkgs.writeShellScriptBin "codesign" ''
        exec /usr/bin/codesign "$@"
      '')
    ];
  });
  example = pkgs.linkFarm "macos-app-example" [
    {
      name = "ctl";
      path = first.ctl;
    }
    {
      name = "primitives";
      path = first.primitives;
    }
    {
      name = "testPrimitives";
      path = testPrimitives;
    }
    {
      name = "ctl-config.json";
      path = first.ctlConfig;
    }
    {
      name = "hostApp";
      path = first.hostApp;
    }
    {
      name = "hostAppBundle";
      path = first.hostAppBundle;
    }
    {
      name = "generation";
      path = first.generation;
    }
    {
      name = "secondGeneration";
      path = second.generation;
    }
    {
      name = "secondHostApp";
      path = second.hostApp;
    }
    {
      name = "tamperedPayload";
      path = tampered;
    }
    {
      name = "desired-host.json";
      path = first.desiredDescriptor;
    }
    {
      name = "completeHostApp";
      path = completeProduct.hostApp;
    }
    {
      name = "complete-ctl-config.json";
      path = completeProduct.ctlConfig;
    }
    {
      name = "complete-desired-host.json";
      path = completeProduct.desiredDescriptor;
    }
    {
      name = "childrenHostApp";
      path = childrenProduct.hostApp;
    }
    {
      name = "children-ctl-config.json";
      path = childrenProduct.ctlConfig;
    }
    {
      name = "children-desired-host.json";
      path = childrenProduct.desiredDescriptor;
    }
    {
      name = "childrenGeneration";
      path = childrenProduct.generation;
    }
    {
      name = "childrenCtl";
      path = childrenProduct.ctl;
    }
  ];
  check = pkgs.runCommand "macos-app-host-stability" { } ''
    test ${pkgs.lib.escapeShellArg first.hostAppBundle} = '${first.hostApp}/SyntheticHost.app'
    test ${pkgs.lib.escapeShellArg first.appBundleName} = 'Synthetic Host.app'
    cmp ${pkgs.lib.escapeShellArg "${first.hostAppBundle}/Contents/MacOS/macos-app-host"} \
      ${pkgs.lib.escapeShellArg "${second.hostAppBundle}/Contents/MacOS/macos-app-host"}
    test '${first.generation}' != '${second.generation}'
    mkdir -p "$out"
    printf 'host byte stability: PASS\n' > "$out/result"
  '';
  # Run from the checkout root: nix run .#macos-app-integration
  integration = pkgs.writeShellScriptBin "macos-app-integration" ''
    exec ${pkgs.python3.withPackages (p: [ p.jsonschema ])}/bin/python3 \
      "$PWD/nix/macos-app/integration.py" "$@"
  '';
  ctlIntegration = pkgs.writeShellScriptBin "macos-app-ctl-integration" ''
    # Pin the production and test-feature ctl binaries, including fixture signing,
    # as runtime dependencies rather than rebuilding the example inside the test.
    if [ "$#" -eq 0 ]; then set -- ${example}; fi
    exec ${pkgs.python3}/bin/python3 "$PWD/nix/macos-app/ctl-integration.py" "$@"
  '';
  smokeProduct =
    text: displayName:
    mkMacosApp {
      name = "SmokeHost";
      bundleId = "dev.overeng.macos-app.smoke";
      inherit displayName;
      signer = {
        teamId = "TEST";
        identity = "Test-only smoke identity";
      };
      session = "background-agent";
      launchd.label = "dev.overeng.macos-app.smoke";
      statusAllowedUids = [ 501 ];
      actions.echo = {
        executable = pkgs.writeShellScript "smoke-payload" "printf '%s\\n' '${text}'";
        allowedUids = [ 501 ];
        timeoutMs = 1000;
      };
    };
  smokeFirst = smokeProduct "first" "Launchd Smoke";
  smokeSecond = smokeProduct "second" "Launchd Smoke";
  smokeChanged = smokeProduct "first" "Launchd Smoke Changed Host";
  smokeAssets = pkgs.linkFarm "macos-app-launchd-smoke-assets" [
    {
      name = "primitives";
      path = testPrimitives;
    }
    {
      name = "hostApp";
      path = smokeFirst.hostApp;
    }
    {
      name = "changedHostApp";
      path = smokeChanged.hostApp;
    }
    {
      name = "generation";
      path = smokeFirst.generation;
    }
    {
      name = "secondGeneration";
      path = smokeSecond.generation;
    }
  ];
  launchdSmoke = pkgs.writeShellScriptBin "macos-app-launchd-smoke" ''
    # Deliberately real system launchctl/codesign, never integration PATH shims.
    export PATH="/usr/bin:/bin:${pkgs.nix}/bin"
    exec ${testPrimitives}/bin/macos-app-launchd-smoke ${smokeAssets} "$@"
  '';
in
{
  inherit
    example
    check
    integration
    ctlIntegration
    launchdSmoke
    ;
  inherit (first) primitives;
}
