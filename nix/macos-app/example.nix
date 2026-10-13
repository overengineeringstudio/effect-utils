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
  ];
  check = pkgs.runCommand "macos-app-host-stability" { } ''
    cmp '${first.hostApp}/SyntheticHost.app/Contents/MacOS/macos-app-host' \
      '${second.hostApp}/SyntheticHost.app/Contents/MacOS/macos-app-host'
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
    exec ${pkgs.python3}/bin/python3 "$PWD/nix/macos-app/ctl-integration.py" "$@"
  '';
in
{
  inherit
    example
    check
    integration
    ctlIntegration
    ;
  inherit (first) primitives;
}
