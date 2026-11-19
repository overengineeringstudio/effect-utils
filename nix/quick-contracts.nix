# Transitional execution projection: devenv still owns evaluated task definitions;
# Buck owns the bounded check invocation. No task runner is called at check time.
{ baseCapabilities }:
{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  root = ../.;
  cfg = config.effectUtils.quickContracts;
  # Fixed bounded check cohort, not a dependency resolver. Source preparation
  # runs separately through the retained authority, before Buck is invoked.
  sequence = import ./quick-contracts-sequence.nix { };
  taskScripts = lib.mapAttrs (
    name: task:
    if task.command == null then
      null
    else
      pkgs.writeShellScript ("quick-contract-" + lib.replaceStrings [ ":" ] [ "-" ] name) (
        "set -e\n"
        + lib.concatStringsSep "\n" (
          lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") task.env
        )
        + "\n"
        + lib.optionalString (task.cwd != null) "cd ${lib.escapeShellArg task.cwd}\n"
        + "exec ${task.command}\n"
      )
  ) config.tasks;
  # Reuse the evaluated native commands and JSON, including interpreter,
  # fail-fast/export semantics and all dependency/status/input metadata.
  # Guards inspect omitted/legacy producers as well as the selected cohort.
  taskAuthority = config.task.config;
  # Conservatively bind the complete tracked source closure, including scripts
  # embedded by Nix path interpolation. Stage new sources before preparation.
  sourceFiles = lib.fileset.toList (lib.fileset.gitTracked root);
  sourceIdentity = pkgs.writeText "quick-contract-source-identity" (
    lib.concatMapStrings (
      file:
      "${builtins.hashFile "sha256" file}  ${lib.removePrefix (toString root + "/") (toString file)}\n"
    ) sourceFiles
  );
  runtimePath = lib.makeBinPath (
    [
      pkgs.bash
      pkgs.coreutils
      pkgs.unixtools.ps
      pkgs.findutils
      pkgs.gnused
      pkgs.gnugrep
      pkgs.git
      pkgs.jq
      pkgs.watchman
      pkgs.openssl
      pkgs.nix
      pkgs.diffutils
      pkgs.gawk
      pkgs.gnutar
      pkgs.gzip
      pkgs.curl
      pkgs.python3

      pkgs.stdenv.cc
    ]
    ++ config.packages
  );
  # Only non-secret execution bindings. Credentials and telemetry context remain
  # caller-owned; neither is serialized into the immutable capability.
  runtimeEnv = lib.getAttrs (builtins.filter (name: builtins.hasAttr name config.env) [
    "BUCK2_BIN"
    "EDITOR_VIEW_SOURCE_LAUNCHER"
    "EDITOR_VIEW_LEASE_BIN"
    "EDITOR_VIEW_LEASE_LIBRARY"
    "EDITOR_VIEW_LEASE_TEST_CHILD_BIN"
    "EDITOR_VIEW_LEASE_UNKNOWN_FS_BIN"
    "EDITOR_VIEW_READER_INFRASTRUCTURE_TEST_CHILD_BIN"
    "GENIE_ACTIONLINT_BIN"
    "JAVASCRIPT_PRODUCT_IMPORT_OPENSSL_BIN"
    "BUCK2_STDIO_LIBRARY"
    "BUCK2_MACHINE_VERSION"
  ]) config.env;
  environment = ''
    set -euo pipefail
    export PATH="''${WORKTREE_POLICY_PATH:+$WORKTREE_POLICY_PATH:}${runtimePath}"
    export DEVENV_ROOT="$PWD" WORKSPACE_ROOT="$PWD"
    : "''${WORKTREE_CAPABILITIES_PROFILE:?run devenv build effectUtils.quickContracts.capabilities and publish the returned profile}"
    export WORKTREE_CAPABILITIES_PROFILE
    ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
      export SDKROOT=${lib.escapeShellArg pkgs.apple-sdk.sdkroot}
      # Outside stdenv setup, the pinned wrapper consumes its target-suffixed flags.
      export NIX_LDFLAGS_${pkgs.stdenv.cc.suffixSalt}=${lib.escapeShellArg "-L${pkgs.libiconv}/lib"}
    ''}
  '';
  validateSource = ''
    if ! sha256sum --check --status ${sourceIdentity}; then
      echo 'quick-contracts: evaluated task authority is stale; run devenv build effectUtils.quickContracts.capabilities and republish WORKTREE_CAPABILITIES_PROFILE' >&2
      exit 78
    fi
    expected=$(wc -l < ${sourceIdentity})
    actual=$(git ls-files | wc -l)
    if [ "$actual" -ne "$expected" ]; then
      echo 'quick-contracts: tracked source census changed; run devenv build effectUtils.quickContracts.capabilities and republish WORKTREE_CAPABILITIES_PROFILE' >&2
      exit 78
    fi
  '';
  prepare = pkgs.writeShellScript "quick-contracts-prepare" ''
    root="''${1:?usage: quick-contracts-prepare ROOT GENERATION}"
    generation="''${2:?usage: quick-contracts-prepare ROOT GENERATION}"
    cd "$root"
    ${environment}
    if [ "$(realpath "$generation/profile")" != "$WORKTREE_CAPABILITIES_PROFILE" ]; then
      echo 'quick-contracts: preparation generation does not root the selected capability profile' >&2
      exit 78
    fi
    ${validateSource}
    mkdir -p .devenv
    rm -f .devenv/quick-contracts-prepared
    # This is an explicit setup operation, never called by a Buck target.
    ${inputs.devenv.packages.${pkgs.stdenv.hostPlatform.system}.devenv}/bin/devenv tasks run \
      buck2:editor:publish:standalone-staging
    receipt=$(mktemp .devenv/quick-contracts-prepared.XXXXXX)
    trap 'rm -f "$receipt"' EXIT
    printf '%s\n%s\n' ${taskAuthority} "$WORKTREE_CAPABILITIES_PROFILE" > "$receipt"
    mv "$receipt" .devenv/quick-contracts-prepared
  '';
  transaction = pkgs.writeShellScript "quick-contract-transaction" ''
    ${environment}
    export DEVENV_TASK_FILE=${taskAuthority} DEVENV_TASKS_JSON=${taskAuthority}
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") runtimeEnv
    )}
    ${validateSource}
    if ! printf '%s\n%s\n' ${taskAuthority} "$WORKTREE_CAPABILITIES_PROFILE" | \
      cmp -s - .devenv/quick-contracts-prepared; then
      echo 'quick-contracts: source views are not prepared for this authority/profile; run the selected quick-contracts capability bin/quick-contracts-prepare before buck2 run //:check-quick' >&2
      exit 78
    fi
    export EFFECT_UTILS_CI_TEST=${lib.escapeShellArg (builtins.getEnv "EFFECT_UTILS_CI_TEST")}
    export EFFECT_UTILS_TEST_PLATFORM=${lib.escapeShellArg (builtins.getEnv "EFFECT_UTILS_TEST_PLATFORM")}
    export BUCK2_REMOTE_CACHE_BASIC_AUTH="''${BUCK2_REMOTE_CACHE_BASIC_AUTH:-}"
    ${lib.concatMapStrings (name: ''
      printf '%s\n' ${lib.escapeShellArg ("quick-contracts: " + name)}
      ${taskScripts.${name}}
    '') sequence}
  '';
  runner = pkgs.writeShellScript "quick-contracts" ''
    exec ${pkgs.coreutils}/bin/timeout --kill-after=5 3600 ${transaction}
  '';
in
{
  options.effectUtils.quickContracts = {
    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
    };
    capabilities = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
    };
  };
  config.effectUtils.quickContracts = {
    package = pkgs.runCommand "quick-contracts" { } ''
      mkdir -p "$out/bin"
      ln -s ${runner} "$out/bin/quick-contracts"
      ln -s ${prepare} "$out/bin/quick-contracts-prepare"
      ln -s ${taskAuthority} "$out/tasks.json"
      ln -s ${sourceIdentity} "$out/source-identity"
    '';
    capabilities =
      (import ./buck2-capabilities.nix {
        inherit pkgs;
        src = root;
        inherit (baseCapabilities) capabilityPackages;
        extraCapabilities = baseCapabilities.extraCapabilities // {
          quick-contracts = {
            kind = "directory";
            package = cfg.package;
            protocol = "effect-utils/quick-contracts/v1";
          };
        };
      }).overrideAttrs
        (previous: {
          # Preserve the producer's regular metadata files and exact tool links.
          # A symlinkJoin would change immutable per-tool entries across profiles.
          buildCommand = previous.buildCommand + ''
            ln -s ${cfg.package} "$out/quick-contracts"
          '';
        });
  };
}
