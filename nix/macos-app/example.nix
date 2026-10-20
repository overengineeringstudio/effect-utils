{ pkgs, nixpkgsRevision }:
let
  mkMacosApp = import ./default.nix { inherit pkgs nixpkgsRevision; };
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
  testPrimitives = first.primitives.overrideAttrs {
    pname = "macos-app-test-primitives";
    cargoBuildFlags = [ "--features=test-signing-cert" ];
    cargoTestFlags = [ "--features=test-signing-cert" ];
  };
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
  ];
  check = pkgs.runCommand "macos-app-host-stability" { } ''
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
