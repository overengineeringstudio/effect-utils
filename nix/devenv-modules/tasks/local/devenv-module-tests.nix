{
  workerCount ? 4,
  scriptWeights ? { },
  testPlatform ? "",
  moduleScriptPlatforms,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  validWeights = builtins.all (weight: builtins.isInt weight && weight > 0) (
    builtins.attrValues scriptWeights
  );
  weightsFile = pkgs.writeText "devenv-module-test-weights.json" (builtins.toJSON scriptWeights);
  scriptPlatformsFile = pkgs.writeText "devenv-module-test-platforms.json" (
    builtins.toJSON moduleScriptPlatforms
  );
  testEntries = builtins.readDir ../shared/tests;
  discoveredScripts = builtins.filter (
    name:
    lib.hasSuffix ".test.sh" name
    && builtins.elem testEntries.${name} [
      "regular"
      "symlink"
    ]
  ) (builtins.attrNames testEntries);
  validEntry =
    entry:
    builtins.isAttrs entry
    && entry ? script
    && builtins.isString entry.script
    && entry ? rationale
    && builtins.isString entry.rationale
    && builtins.match ".*[^[:space:]].*" entry.rationale != null
    && (!(entry ? fullProfileOnly) || builtins.isBool entry.fullProfileOnly);
  validPlatforms =
    builtins.isAttrs moduleScriptPlatforms
    &&
      builtins.attrNames moduleScriptPlatforms == [
        "darwin"
        "neutral"
      ]
    && builtins.isList moduleScriptPlatforms.darwin
    && builtins.isList moduleScriptPlatforms.neutral
    && builtins.all validEntry (moduleScriptPlatforms.darwin ++ moduleScriptPlatforms.neutral);
  classifiedScripts = map (entry: entry.script) (
    moduleScriptPlatforms.darwin ++ moduleScriptPlatforms.neutral
  );
  completeClassification =
    builtins.length classifiedScripts == builtins.length (lib.unique classifiedScripts)
    && builtins.sort builtins.lessThan classifiedScripts == discoveredScripts;

  devenvModuleTestsScript = pkgs.writeShellScript "devenv-module-tests" ''
    set -euo pipefail

    export NIX_FLAKE_REF="git+file://$PWD?shallow=1"
    export BUN_BIN=${pkgs.bun}/bin/bun
    export BASH_BIN=${pkgs.bashNonInteractive}/bin/bash
    export DATE_BIN=${pkgs.coreutils}/bin/date
    export XARGS_BIN=${pkgs.findutils}/bin/xargs
    export JQ_BIN=${pkgs.jq}/bin/jq
    export RUSTC_BIN=${pkgs.rustc}/bin/rustc
    export MODULE_TEST_WORKERS=${toString workerCount}
    export MODULE_TEST_WEIGHTS=${weightsFile}
    export MODULE_TEST_PLATFORM=${lib.escapeShellArg testPlatform}
    export MODULE_TEST_PLATFORMS=${scriptPlatformsFile}
    exec "$BASH_BIN" ${./devenv-module-tests.sh} \
      "$PWD/nix/devenv-modules/tasks/shared/tests"
  '';
in
assert builtins.isInt workerCount && workerCount > 0;
assert validWeights;
assert builtins.elem testPlatform [
  ""
  "linux"
  "darwin"
];
assert lib.assertMsg validPlatforms
  "Module script platforms must contain darwin/neutral script entries with rationales";
assert lib.assertMsg completeClassification
  "Module script platforms must classify every discovered *.test.sh exactly once";
{
  tasks."devenv-modules:test" = {
    description = "Run shared module shell tests with ${toString workerCount} isolated workers and a serial shared-state barrier";
    exec = trace.exec "devenv-modules:test" "${devenvModuleTestsScript}";
    after = [ "pnpm:install" ];
  };
}
