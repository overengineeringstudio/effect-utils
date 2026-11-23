# Transitional execution projection: devenv still owns evaluated task definitions;
# Buck owns the bounded check invocation. No task runner is called at check time.
{ baseCapabilities, preparedTools }:
{
  config,
  inputs,
  lib,
  pkgs,
  options,
  ...
}:
let
  root = ../.;
  cfg = config.effectUtils.quickContracts;
  # Fixed bounded check cohort, not a dependency resolver. Source preparation
  # runs separately through the retained authority, before Buck is invoked.
  sequence = import ./quick-contracts-sequence.nix { };
  targets = builtins.fromJSON (builtins.readFile ./quick-contracts-targets.json);
  # Only the selected catalog semantics, never source bytes or frozen filenames.
  membershipSpecification = pkgs.writeText "quick-contracts-membership-inputs.json" (
    builtins.toJSON {
      schemaVersion = 1;
      contracts =
        lib.genAttrs (builtins.filter (name: (targets.${name}.membership or [ ]) != [ ]) sequence)
          (name: {
            inherit (targets.${name}) membership;
            membership_mode = targets.${name}.membership_mode or "tracked";
          });
    }
  );
  selectedAfter =
    name: builtins.filter (dependency: builtins.elem dependency sequence) config.tasks.${name}.after;
  validRequires = builtins.all (
    name:
    builtins.sort builtins.lessThan targets.${name}.requires
    == builtins.sort builtins.lessThan (selectedAfter name)
  ) sequence;
  compileTaskScripts =
    tasks:
    lib.mapAttrs (
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
    ) tasks;
  taskScripts = compileTaskScripts config.tasks;
  # Use the owning devenv task type/compiler, not a parallel exec interpreter.
  # Only the fixture's definitions belong here: the real repo's cwd/release task
  # must never be projected into a destructive synthetic-worktree test.
  teardownFixture = lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      { options.tasks = lib.mkOption { type = options.tasks.type; }; }
      (import ./devenv-modules/tasks/shared/tests/worktree-teardown-fixture.nix {
        sourceRoot = root;
      })
    ];
  };
  teardownFixtureScripts = compileTaskScripts teardownFixture.config.tasks;
  teardownFixtureRunner =
    assert lib.assertMsg (builtins.all (task: task.cwd == null && task.env == { }) (
      builtins.attrValues teardownFixture.config.tasks
    )) "quick-contracts: teardown fixture must inherit its synthetic cwd and root";
    pkgs.writeShellScript "quick-contract-teardown-fixture" ''
      set -euo pipefail
      [ "$#" -eq 0 ]
      # Rebind the root after the caller enters its owned synthetic worktree.
      export DEVENV_ROOT="$PWD" WORKSPACE_ROOT="$PWD"
      [ "$(${pkgs.git}/bin/git rev-parse --show-toplevel)" = "$PWD" ]
      export WORKTREE_TEARDOWN_EDITOR_RELEASE_COMMAND=${teardownFixtureScripts."buck2:editor:release"}
      exec ${teardownFixtureScripts."worktree:teardown"}
    '';
  notionCiTaskCommands = pkgs.writeText "quick-contract-notion-ci-task-commands.json" (
    builtins.toJSON (
      lib.mapAttrs (_: script: toString script) (
        lib.filterAttrs (
          name: script:
          script != null
          && lib.hasPrefix "test:notion-integration:" name
          && name != "test:notion-integration:ci-skip"
        ) taskScripts
      )
    )
  );
  # Reuse the evaluated native commands and JSON, including interpreter,
  # fail-fast/export semantics and all dependency/status/input metadata.
  # Guards inspect omitted/legacy producers as well as the selected cohort.
  taskAuthority = config.task.config;
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
    "BUCK2_NATIVE_BIN"
    "BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY"
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
  # Shared native/policy bindings, deliberately excluding the aggregate profile
  # and prepared receipt from individual executable closures.
  runtimeEnvironment = ''
    set -euo pipefail
    export PATH="''${WORKTREE_POLICY_PATH:+$WORKTREE_POLICY_PATH:}${runtimePath}"
    export DEVENV_ROOT="$PWD" WORKSPACE_ROOT="$PWD"
    export WORKTREE_GIT=${pkgs.git}/bin/git
    # Pin the runtime fallback to the owning prepare receipt, not a mutable
    # current-generation link. Preserve an explicit caller override.
    if [ -z "''${WORKTREE_CAPABILITIES_PROFILE:-}" ]; then
      {
        IFS= read -r prepared_authority
        IFS= read -r prepared_profile
      } < "$PWD/.devenv/quick-contracts-prepared"
      : "''${prepared_profile:?quick-contracts: prepared receipt has no profile}"
      WORKTREE_CAPABILITIES_PROFILE="$(${pkgs.coreutils}/bin/realpath -e "$prepared_profile")"
    fi
    export WORKTREE_CAPABILITIES_PROFILE
    ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
      export SDKROOT=${lib.escapeShellArg pkgs.apple-sdk.sdkroot}
      # Outside stdenv setup, the pinned wrapper consumes its target-suffixed flags.
      export NIX_LDFLAGS_${pkgs.stdenv.cc.suffixSalt}=${lib.escapeShellArg "-L${pkgs.libiconv}/lib"}
    ''}
  '';
  environment = ''
    ${runtimeEnvironment}
    : "''${WORKTREE_CAPABILITIES_PROFILE:?run devenv build effectUtils.quickContracts.capabilities and publish the returned profile}"
    export WORKTREE_CAPABILITIES_PROFILE
  '';
  runtimeExports = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") runtimeEnv
  );
  selectionExports = ''
    export EFFECT_UTILS_CI_TEST=${lib.escapeShellArg (builtins.getEnv "EFFECT_UTILS_CI_TEST")}
    export EFFECT_UTILS_TEST_PLATFORM=${lib.escapeShellArg (builtins.getEnv "EFFECT_UTILS_TEST_PLATFORM")}
    export BUCK2_REMOTE_CACHE_BASIC_AUTH="''${BUCK2_REMOTE_CACHE_BASIC_AUTH:-}"
  '';
  # Buck's scratch TMPDIR is inside buck-out and can exceed AF_UNIX limits.
  # Preserve fixture-owned private dirs and process lifetimes; do not supervise them.
  taskRuntime = pkgs.writeShellScript "quick-contract-task-runtime" ''
    set -euo pipefail
    # Canonicalize /tmp on Darwin before guards compare physical repo paths.
    export TMPDIR="$(${pkgs.coreutils}/bin/realpath -e -- /tmp)"
    export TMP="$TMPDIR" TEMP="$TMPDIR" RUNNER_TEMP="$TMPDIR"
    exec "$@"
  '';
  taskCapabilities = builtins.listToAttrs (
    map (
      name:
      let
        id = "quick-contract-" + lib.replaceStrings [ ":" ] [ "-" ] name;
        check = pkgs.writeShellScriptBin id ''
          ${runtimeEnvironment}
          if [ "$#" -ne 1 ] || [ -z "$1" ]; then
            echo 'usage: ${id} VERDICT_OUTPUT' >&2
            exit 64
          fi
          # Resolve before the evaluated task script applies its own cwd.
          verdict=$(realpath -m -- "$1")
          rm -f -- "$verdict"
          ${runtimeExports}
          ${selectionExports}
          # Inherit, never embed, the caller's selected profile. worktree-env.py
          # rejects a base-profile override against a published full generation;
          # nested commands retain the pinned direct BUCK2_BIN binding instead.
          ${lib.optionalString
            (builtins.elem name [
              "buck2:task-guards:check"
              "check:buck2-producer-overlap"
            ])
            ''
              export DEVENV_TASK_FILE=${taskAuthority} DEVENV_TASKS_JSON=${taskAuthority}
            ''
          }
          ${lib.optionalString (name == "test:notion-integration:ci-skip") ''
            export NOTION_INTEGRATION_TASK_COMMANDS_FILE=${notionCiTaskCommands}
          ''}
          ${lib.optionalString (name == "worktree:teardown:test") ''
            export WORKTREE_TEARDOWN_TASK_COMMAND=${teardownFixtureRunner}
          ''}
          ${taskRuntime} ${taskScripts.${name}}
          mkdir -p -- "$(dirname "$verdict")"
          printf '%s\n' ${
            lib.escapeShellArg (
              builtins.toJSON {
                task = name;
                status = "passed";
              }
            )
          } > "$verdict"
        '';
      in
      {
        name = id;
        value = {
          kind = "executable";
          # Executable capabilities must resolve inside their own Nix output.
          package = check;
          executable = "bin/${id}";
          protocol = "effect-utils/quick-contract-task/v1";
        };
      }
    ) sequence
  );
  # The profile must prove the selected tool/task bytes it was evaluated from.
  # Checking fresh tools alone would let an old full-profile override re-publish
  # obsolete task commands after an authority edit.
  validateAuthority = ''
    actual_inputs="$(${pkgs.python3}/bin/python3 ${../scripts/worktree-env.py} \
      inputs-digest ${preparedTools.identity-inputs-manifest} "$PWD")"
    if ! printf '%s\n' "$actual_inputs" | cmp -s - ${preparedTools.identity-inputs-digest}; then
      echo 'quick-contracts: frozen tool/task authority is stale; rebuild effectUtils.quickContracts.capabilities, republish WORKTREE_CAPABILITIES_PROFILE and prepare again' >&2
      exit 78
    fi
  '';
  validatePrepared = ''
    ${validateAuthority}
    if ! printf '%s\n%s\n' ${taskAuthority} "$WORKTREE_CAPABILITIES_PROFILE" | \
      cmp -s - .devenv/quick-contracts-prepared; then
      echo 'quick-contracts: source views are not prepared for this authority/profile; run the selected quick-contracts capability bin/quick-contracts-prepare before buck2 run //:check-quick' >&2
      exit 78
    fi
    # Buck owns each contract's source digests. Only frozen tool/task inputs
    # belong to the prepared environment; a check-source edit needs no Nix.
    ${pkgs.python3}/bin/python3 ${../scripts/worktree-env.py} check \
      "$PWD/.worktree-tools/v2/current/tools" > /dev/null
  '';
  reporter = pkgs.writeShellScript "quick-contracts-report" ''
    ${environment}
    ${validatePrepared}
    if [ "$#" -ne ${toString (builtins.length sequence)} ]; then
      echo 'quick-contracts-report: supply exactly one successful verdict per selected task' >&2
      exit 64
    fi
    if ! jq -e -s --argjson expected ${lib.escapeShellArg (builtins.toJSON sequence)} '
      all(.[]; type == "object" and keys == ["status", "task"] and .status == "passed")
      and (map(.task) | sort) == ($expected | sort)
    ' "$@" > /dev/null; then
      echo 'quick-contracts-report: verdicts do not cover the selected tasks exactly once' >&2
      exit 1
    fi
    printf 'quick-contracts: %s selected contracts passed\n' ${toString (builtins.length sequence)}
  '';
  prepare = pkgs.writeShellScript "quick-contracts-prepare" ''
    root="''${1:?usage: quick-contracts-prepare ROOT GENERATION}"
    generation="''${2:?usage: quick-contracts-prepare ROOT GENERATION}"
    cd "$root"
    ${environment}
    ${validateAuthority}
    if [ "$(realpath "$generation/profile")" != "$WORKTREE_CAPABILITIES_PROFILE" ]; then
      echo 'quick-contracts: preparation generation does not root the selected capability profile' >&2
      exit 78
    fi
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
    ${runtimeExports}
    ${validatePrepared}
    ${selectionExports}
    ${lib.optionalString (builtins.elem "test:notion-integration:ci-skip" sequence) ''
      export NOTION_INTEGRATION_TASK_COMMANDS_FILE=${notionCiTaskCommands}
    ''}
    ${lib.optionalString (builtins.elem "worktree:teardown:test" sequence) ''
      export WORKTREE_TEARDOWN_TASK_COMMAND=${teardownFixtureRunner}
    ''}
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
    # Option discovery must not force the config fixed point. Check the real
    # evaluated task DAG only when its execution package is requested.
    package =
      assert lib.assertMsg validRequires
        "quick-contracts: catalog requires must match the selected evaluated task.after dependencies";
      pkgs.runCommand "quick-contracts" { } ''
        mkdir -p "$out/bin" "$out/share"
        ln -s ${runner} "$out/bin/quick-contracts"
        ln -s ${prepare} "$out/bin/quick-contracts-prepare"
        ln -s ${reporter} "$out/bin/quick-contracts-report"
        ln -s ${taskAuthority} "$out/tasks.json"
        ln -s ${membershipSpecification} "$out/share/membership-inputs.json"
      '';
    capabilities =
      (import ./buck2-capabilities.nix {
        inherit pkgs;
        src = root;
        inherit (baseCapabilities) capabilityPackages;
        extraCapabilities =
          baseCapabilities.extraCapabilities
          // taskCapabilities
          // {
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
