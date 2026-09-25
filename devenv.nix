{
  pkgs,
  inputs,
  config,
  lib,
  ...
}:
let
  # `git+file://` and not a bare path: `builtins.getFlake (toString ./.)`
  # parses as a `path:` flakeref, which copies the entire working directory —
  # gitignored `.devenv/` included, 546 MB / 25,142 files against 18 MB / 2,746
  # for the git-tracked view — into the store on every eval, and re-copies it
  # whenever devenv writes its own state. Measured 82.4 s -> 14.6 s median on a
  # forced eval-cache miss.
  #
  # The assertion is the other half. `git+file://` needs `./.` to be a real
  # worktree, and #1190 is what happens when it is not: config evaluated from a
  # store-backed source has no `.git`, and this expression dies where a bare
  # path would have limped on.
  repoFlake =
    assert lib.assertMsg (builtins.pathExists (./. + "/.git")) ''
      devenv.nix: `repoFlake` needs `./.` to be a real git worktree, and
      ${toString ./.} has no `.git`.

      This is the #1190 regression: `builtins.getFlake "git+file://…"` is fine
      while `./.` is a checkout and fails the moment this file is evaluated
      from a store path. If you moved config evaluation onto a store-backed
      source, pass that source in explicitly rather than re-deriving it here.
    '';
    builtins.getFlake "git+file://${toString ./.}";
  currentSystem = pkgs.stdenv.hostPlatform.system;
  buck2Capabilities = repoFlake.packages.${currentSystem}.buck2-capabilities;
  flakePkgs = import repoFlake.inputs.nixpkgs { system = currentSystem; };
  # The flake wires the source recipes that cache-native manifest rows require;
  # re-importing the loader here without them fails on every cache-native product.
  trackedBuck2Products = repoFlake.buckProducts.${currentSystem};
  pnpmArchives = import ./nix/buck2-products/pnpm-archives.nix { pkgs = flakePkgs; };
  # `restate` ships under BSL-1.1; scope allowUnfree to just that package so the
  # rest of the closure stays free-only.
  restatePkgs = import repoFlake.inputs.nixpkgs {
    system = currentSystem;
    config.allowUnfreePredicate = pkg: builtins.elem (pkgs.lib.getName pkg) [ "restate" ];
  };
  restate = import ./nix/restate.nix { pkgs = restatePkgs; };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings and the two tracked Buck plugin modules.
  oxlintNpm = import ./nix/oxlint-npm.nix {
    pkgs = flakePkgs;
    bun = flakePkgs.bun;
    inherit pnpmArchives;
    products = trackedBuck2Products.products;
  };
  oxlintWithPlugins = import ./nix/oxlint-with-plugins.nix {
    inherit pkgs oxlintNpm;
  };
  nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh
  );
  rustCrates = [
    {
      name = "otelite";
      path = "packages/@overeng/otelite";
    }
    {
      name = "otel-scrape";
      path = "packages/@overeng/otel-scrape";
    }
  ];
  trace = import ./nix/devenv-modules/tasks/lib/trace.nix { inherit lib; };

  # Shared task modules (from shared/ directory)
  taskModules = {
    genie = ./nix/devenv-modules/tasks/shared/genie.nix;
    worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    devenv-eval-input-budget = import ./nix/devenv-modules/tasks/shared/devenv-eval-input-budget.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
    workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    buck2-rust-deps = import ./nix/devenv-modules/tasks/shared/buck2-rust-deps.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
    secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
    weaver-diff = import ./nix/devenv-modules/tasks/shared/weaver-diff.nix;
    weaver-live-check = import ./nix/devenv-modules/tasks/shared/weaver-live-check.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
    devenv-module-tests = ./nix/devenv-modules/tasks/local/devenv-module-tests.nix;
  };
  # Repository CLIs come from the reviewed Buck product boundary, not from a
  # source entrypoint that exists only here. The activated shell, the flake
  # outputs, and CI therefore run the same content-addressed bytes, so a task
  # cannot pass locally against a source tree and fail against the product.
  repoPackages = repoFlake.packages.${currentSystem};

  # Real packages backing guarded command names. The cli-guards own bin/<name>
  # and exec these via absolute store path under passthrough, so they are passed
  # as `*Pkg` reals to the task modules instead of also being top-level profile
  # providers (which would collide with the guards in buildEnv). See cli-guard.nix.
  pnpmPkg = import ./nix/pnpm.nix { inherit pkgs; };
  genieCli = repoPackages.genie;
  mrCli = repoPackages.megarepo;
  ciToolsCli = repoPackages.ci-tools;
  tuiStoriesCli = repoPackages.tui-stories;
  ghCiUtilsCli = repoPackages.gh-ci-utils;
  buck2Machine = import ./nix/buck2.nix { pkgs = flakePkgs; };
  buck2Stage0Definition = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };

  # The generated root package manifest is the workspace package authority.
  # Consuming it here removes the former hand-maintained Nix package list and
  # makes Genie freshness the single stage-zero synchronization boundary.
  allPackages = (builtins.fromJSON (builtins.readFile ./package.json)).workspaces;

  packageTestQuarantine = { };
  validatedPackageTestQuarantine = lib.mapAttrs (
    name: quarantine:
    if quarantine ? reason && quarantine ? issue then
      quarantine
    else
      throw "packageTestQuarantine.${name} must include reason and issue"
  ) packageTestQuarantine;
  packagesRoot = ./. + "/packages/@overeng";
  hasTestFiles =
    root:
    let
      scan =
        dir:
        if builtins.pathExists dir then
          let
            entries = builtins.readDir dir;
            names = builtins.attrNames entries;
          in
          builtins.any (
            name:
            let
              entryType = entries.${name};
              child = dir + "/${name}";
            in
            if entryType == "regular" then
              builtins.match ".*\\.(spec|test)\\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)" name != null
            else if entryType == "directory" then
              scan child
            else
              false
          ) names
        else
          false;
    in
    scan (root + "/src") || scan (root + "/test");
  # Packages that have Vitest tests are discovered from the filesystem. If a
  # package with tests is excluded, it must be visible debt in packageTestQuarantine.
  packagesWithTests =
    let
      packageNames = builtins.filter (
        name:
        let
          root = packagesRoot + "/${name}";
        in
        (builtins.readDir packagesRoot).${name} == "directory"
        && builtins.pathExists (root + "/package.json")
        && hasTestFiles root
        && !(builtins.hasAttr name validatedPackageTestQuarantine)
      ) (builtins.attrNames (builtins.readDir packagesRoot));
    in
    map (name: {
      path = "packages/@overeng/${name}";
      inherit name;
    }) packageNames;

  # Generated bridge between the package-local Buck test declarations and the devenv task
  # graph. It is the single semantic registry for which suites Buck executes; nothing here
  # re-derives lane membership — it only refuses a bridge that does not conform, because a
  # silently shrunken or malformed registry would hand admitted suites back to source Vitest.
  buck2TestAuthorityFile = ./buck2-test-authority.json;
  buck2TestAuthority = builtins.fromJSON (builtins.readFile buck2TestAuthorityFile);
  # Deliberate floor, not a derived value: shrinking the registry means editing this number.
  buck2TestAuthorityMinimumLanes = 34;
  buck2TestAuthorityLanes =
    if (buck2TestAuthority.schemaVersion or null) == 2 then
      buck2TestAuthority.lanes
    else
      throw "buck2-test-authority.json is not a schemaVersion 2 test authority";
  # Exactly the target-name shape the Buck projection accepts; keep in lockstep with it.
  testTargetNamePattern = "[a-z][a-z0-9_]*";
  normalizedRelativePath =
    value:
    value != ""
    && !(lib.hasInfix "\\" value)
    && builtins.all (segment: segment != "" && segment != "." && segment != "..") (
      lib.splitString "/" value
    );
  buck2TestLaneIssues =
    lane:
    let
      labelPrefix = "effect_utils//${lane.packagePath}:";
      hasLabelPrefix = lib.hasPrefix labelPrefix lane.target;
      targetName = lib.removePrefix labelPrefix lane.target;
      expectedTaskName =
        if !hasLabelPrefix || targetName == "test" then
          "test:${lane.packageName}"
        else
          "test:${lane.packageName}:${targetName}";
      sourceFiles = builtins.filter (
        file: !(builtins.elem file lane.selectedTestFiles) || builtins.elem file lane.excludes
      ) lane.testFiles;
      sourceOwnerFiles = builtins.attrNames lane.sourceOwners;
      expectedUnboundedFiles = builtins.filter (
        file: !(builtins.hasAttr file lane.sourceOwners)
      ) sourceFiles;
      taskNamePattern = "[a-z0-9][a-z0-9:-]*";
      validTaskName = value: builtins.match taskNamePattern value != null;
      prefix = "lane ${lane.target}: ";
    in
    lib.optional (!(normalizedRelativePath lane.packagePath)) (
      "${prefix}packagePath ${lane.packagePath} is not a normalized relative path"
    )
    ++ lib.optional (lane.packageName != lib.last (lib.splitString "/" lane.packagePath)) (
      "${prefix}packageName ${lane.packageName} is not the last segment of ${lane.packagePath}"
    )
    ++ lib.optional (!hasLabelPrefix || builtins.match testTargetNamePattern targetName == null) (
      "${prefix}target is not ${labelPrefix}<name> with a ${testTargetNamePattern} name"
    )
    ++ lib.optional (lane.taskName != expectedTaskName) (
      "${prefix}taskName ${lane.taskName} is not the derived ${expectedTaskName}"
    )
    ++ lib.optional (lane.testFiles == [ ]) "${prefix}testFiles is empty"
    ++ lib.optional (!(builtins.all normalizedRelativePath lane.testFiles)) (
      "${prefix}testFiles contains a non-normalized package-relative path"
    )
    ++ lib.optional (lane.testFiles != builtins.sort builtins.lessThan lane.testFiles) (
      "${prefix}testFiles is not byte-sorted"
    )
    ++ lib.optional (
      lib.unique lane.testFiles != lane.testFiles
    ) "${prefix}testFiles contains a duplicate"
    ++ lib.optional (lane.selectedTestFiles == [ ]) "${prefix}selectedTestFiles is empty"
    ++ lib.optional (!(builtins.all (file: builtins.elem file lane.testFiles) lane.selectedTestFiles)) (
      "${prefix}selectedTestFiles contains a file outside testFiles"
    )
    ++ lib.optional (
      lane.selectedTestFiles != builtins.sort builtins.lessThan lane.selectedTestFiles
    ) "${prefix}selectedTestFiles is not byte-sorted"
    ++ lib.optional (lib.unique lane.selectedTestFiles != lane.selectedTestFiles) (
      "${prefix}selectedTestFiles contains a duplicate"
    )
    ++ lib.optional (!(builtins.all (file: builtins.elem file lane.selectedTestFiles) lane.excludes)) (
      "${prefix}excludes contains a file outside selectedTestFiles"
    )
    ++ lib.optional (lane.excludes != builtins.sort builtins.lessThan lane.excludes) (
      "${prefix}excludes is not byte-sorted"
    )
    ++ lib.optional (lib.unique lane.excludes != lane.excludes) "${prefix}excludes contains a duplicate"
    ++ lib.optional (!(builtins.all (file: builtins.elem file sourceFiles) sourceOwnerFiles)) (
      "${prefix}sourceOwners contains a file that is not source-owned"
    )
    ++ lib.optional (!(builtins.all validTaskName (builtins.attrValues lane.sourceOwners))) (
      "${prefix}sourceOwners contains an unsafe task name"
    )
    ++ lib.optional (lane.unboundedFiles != expectedUnboundedFiles) (
      "${prefix}unboundedFiles is not the source census minus explicit sourceOwners"
    )
    ++ lib.optional (!(builtins.all validTaskName lane.unboundedAfter)) (
      "${prefix}unboundedAfter contains an unsafe task name"
    )
    ++ lib.optional (lib.unique lane.unboundedAfter != lane.unboundedAfter) (
      "${prefix}unboundedAfter contains a duplicate"
    )
    ++ lib.optional ((lane ? unboundedTaskName) != (lane.unboundedFiles != [ ])) (
      "${prefix}unboundedTaskName must be declared exactly when unboundedFiles is non-empty"
    )
    ++ lib.optional ((lane.unboundedFiles == [ ]) && (lane.unboundedAfter != [ ])) (
      "${prefix}unboundedAfter is non-empty without an unbounded complement"
    )
    ++ lib.optional (
      (lane ? unboundedTaskName) && lane.unboundedTaskName != "${lane.taskName}:unbounded"
    ) "${prefix}unboundedTaskName is not ${lane.taskName}:unbounded"
    ++ lib.optional (
      lane.runner == "vitest" && (lane.collectionTarget or null) != "${lane.target}_collect"
    ) "${prefix}vitest lane must declare collectionTarget ${lane.target}_collect"
    ++ lib.optional (lane.runner != "vitest" && lane ? collectionTarget) (
      "${prefix}${lane.runner} lane must not declare a collectionTarget"
    )
    ++ lib.optional (
      !(builtins.elem lane.runner [
        "bun"
        "shell"
        "vitest"
      ])
    ) ("${prefix}runner ${lane.runner} is not one of bun, shell, vitest");
  buck2TestAuthorityTargets = map (lane: lane.target) buck2TestAuthorityLanes;
  buck2TestAuthorityTaskNames = builtins.concatMap (
    lane: [ lane.taskName ] ++ lib.optional (lane ? unboundedTaskName) lane.unboundedTaskName
  ) buck2TestAuthorityLanes;
  buck2TestAuthorityCollectionTargets = builtins.concatMap (
    lane: lib.optional (lane ? collectionTarget) lane.collectionTarget
  ) buck2TestAuthorityLanes;
  buck2TestAuthorityIssues =
    builtins.concatMap buck2TestLaneIssues buck2TestAuthorityLanes
    ++
      lib.optional (builtins.length buck2TestAuthorityLanes < buck2TestAuthorityMinimumLanes)
        "registry declares ${toString (builtins.length buck2TestAuthorityLanes)} lanes, fewer than the ${toString buck2TestAuthorityMinimumLanes} it must carry"
    ++ lib.optional (
      buck2TestAuthorityTargets != builtins.sort builtins.lessThan buck2TestAuthorityTargets
    ) "lanes are not byte-sorted by target"
    ++ lib.optional (lib.unique buck2TestAuthorityTargets != buck2TestAuthorityTargets) (
      "lanes declare a duplicate target"
    )
    ++ lib.optional (
      builtins.length (lib.unique buck2TestAuthorityTaskNames)
      != builtins.length buck2TestAuthorityTaskNames
    ) "lanes declare a duplicate task name"
    ++ lib.optional (
      builtins.length (lib.unique buck2TestAuthorityCollectionTargets)
      != builtins.length buck2TestAuthorityCollectionTargets
    ) "lanes declare a duplicate collection target";
  discoveredTestPackagePaths = map (pkg: pkg.path) packagesWithTests;
  # A lane whose package carries no discovered Vitest tests (or is quarantined) means the
  # generated bridge and the filesystem have drifted apart; fail every consumer of the lanes
  # rather than relying on an unrelated source-task binding to force the assertion.
  buck2TestLanesWithoutSources = builtins.filter (
    lane: !(builtins.elem lane.packagePath discoveredTestPackagePaths)
  ) buck2TestAuthorityLanes;
  buck2TestLanes =
    assert lib.assertMsg (buck2TestAuthorityIssues == [ ]) ''
      buck2-test-authority.json is not a conformant test authority:
        ${lib.concatStringsSep "\n  " buck2TestAuthorityIssues}
    '';
    assert lib.assertMsg (buck2TestLanesWithoutSources == [ ]) ''
      buck2-test-authority.json declares lanes for packages with no discovered Vitest tests:
      ${lib.concatMapStringsSep ", " (lane: lane.packagePath) buck2TestLanesWithoutSources}
    '';
    buck2TestAuthorityLanes;
  buck2TestLanePackagePaths = map (lane: lane.packagePath) buck2TestLanes;
  # Buck executes every admitted bounded lane. Source Vitest keeps packages absent from the
  # authority and each lane's exact generic complement; explicit live/e2e owners run separately.
  sourceOnlyTestPackages = builtins.filter (
    pkg: !(builtins.elem pkg.path buck2TestLanePackagePaths)
  ) packagesWithTests;
  unboundedTestPackages = map (lane: {
    path = lane.packagePath;
    name = lib.removePrefix "test:" lane.unboundedTaskName;
    # Positional filters, so the complement schedules only its explicit unbounded files.
    vitestArgs = lib.concatStringsSep " " (map lib.escapeShellArg lane.unboundedFiles);
    after = lane.unboundedAfter;
  }) (builtins.filter (lane: lane.unboundedFiles != [ ]) buck2TestLanes);
  sourceTestPackages = sourceOnlyTestPackages ++ unboundedTestPackages;
  typescriptPublicationRootPredicate = ''
    typescript_publication_workspace_root() {
      local member_root workspace_root branch_ref repo_root bare_repo common_dir admin_dir
      local backlink backlink_dir repository_root

      member_root="$(${pkgs.coreutils}/bin/realpath "$1")" || return 1

      # The tracked Buck root is the ordinary publication shape. Its root marker and
      # Git top-level identity prevent a directory that merely resembles repos/effect-utils
      # from inheriting write authority.
      if [ -f "$member_root/.buckroot" ]; then
        repository_root="$(${pkgs.git}/bin/git -C "$member_root" rev-parse \
          --path-format=absolute --show-toplevel)" || return 1
        repository_root="$(${pkgs.coreutils}/bin/realpath "$repository_root")" || return 1
        [ "$repository_root" = "$member_root" ] || return 1
        printf "%s\n" "$member_root"
        return 0
      fi

      # The composed shape remains an explicit downstream compatibility boundary.
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$member_root/../..")" || return 1
      [ "$member_root" = "$workspace_root/repos/effect-utils" ] || return 1
      [ -f "$member_root/.git" ] || return 1

      branch_ref="$(${pkgs.git}/bin/git -C "$member_root" symbolic-ref --quiet HEAD)" || return 2
      case "$branch_ref" in
        refs/heads/*) ;;
        *) return 1 ;;
      esac

      common_dir="$(${pkgs.git}/bin/git -C "$member_root" rev-parse \
        --path-format=absolute --git-common-dir)" || return 2
      common_dir="$(${pkgs.coreutils}/bin/realpath "$common_dir")" || return 2
      bare_repo="$common_dir"
      [ "$(${pkgs.coreutils}/bin/basename "$bare_repo")" = ".bare" ] || return 2
      repo_root="$(${pkgs.coreutils}/bin/dirname "$bare_repo")"
      [ "$workspace_root" = "$repo_root/$branch_ref" ] || return 1

      admin_dir="$(${pkgs.git}/bin/git -C "$member_root" rev-parse \
        --path-format=absolute --git-dir)" || return 2
      admin_dir="$(${pkgs.coreutils}/bin/realpath "$admin_dir")" || return 2
      [ "$(${pkgs.coreutils}/bin/dirname "$admin_dir")" = "$bare_repo/worktrees" ] ||
        return 2
      [ -f "$admin_dir/gitdir" ] || return 2
      backlink="$(<"$admin_dir/gitdir")"
      case "$backlink" in
        /*) ;;
        *) backlink="$admin_dir/$backlink" ;;
      esac
      backlink_dir="$(${pkgs.coreutils}/bin/realpath \
        "$(${pkgs.coreutils}/bin/dirname "$backlink")")" || return 2
      backlink="$backlink_dir/$(${pkgs.coreutils}/bin/basename "$backlink")"
      [ "$backlink" = "$member_root/.git" ] || return 2

      printf "%s\n" "$workspace_root"
    }
  '';
  standaloneBuckCachePosture = ''
    ${pkgs.bun}/bin/bun "$root/scripts/buck2-cache-posture.ts" "$root"
  '';

  buck2BuildExec =
    { name, targets }:
    trace.exec name ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      ${standaloneBuckCachePosture}
      cd "$root"
      exec "$BUCK2_BIN" build \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        ${lib.concatStringsSep " \\\n        " targets}
    '';

  # Every Buck-invoking task uses the checkout's pinned binary and standalone
  # project root, so CI lanes cannot silently fall back to a composed workspace.
  buck2UnitTestExec =
    { name, targets }:
    trace.exec name ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      ${standaloneBuckCachePosture}
      cd "$root"
      exec "$BUCK2_BIN" test \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        --local-only \
        ${lib.concatStringsSep " \\\n        " targets}
    '';
  # Standalone `test:<package>`: the Buck-owned bounded lane plus its source-owned complement,
  # so asking for one package's tests still runs all of that package's tests.
  buck2TestLaneTasks = lib.listToAttrs (
    map (
      lane:
      lib.nameValuePair lane.taskName {
        description = "Execute the bounded ${lane.packageName} unit-test lane under Buck";
        after = [ "genie:check" ] ++ lib.optional (lane ? unboundedTaskName) lane.unboundedTaskName;
        # trace-audit-allow: buck2UnitTestExec returns a trace.exec-wrapped command.
        exec = buck2UnitTestExec {
          name = lane.taskName;
          targets = [ lane.target ];
        };
      }
    ) buck2TestLanes
  );

  # Packages that have storybook (subset of allPackages)
  packagesWithStorybook = [
    {
      path = "packages/@overeng/tui-react";
      name = "tui-react";
      port = 6006;
    }
    {
      path = "packages/@overeng/megarepo";
      name = "megarepo";
      port = 6007;
    }
    {
      path = "packages/@overeng/genie";
      name = "genie";
      port = 6008;
    }
    {
      path = "packages/@overeng/effect-react";
      name = "effect-react";
      port = 6009;
    }
    {
      path = "packages/@overeng/effect-schema-form-aria";
      name = "effect-schema-form-aria";
      port = 6010;
    }
    {
      path = "packages/@overeng/react-inspector";
      name = "react-inspector";
      port = 6011;
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      port = 6012;
    }
    {
      path = "packages/@overeng/tui-stories";
      name = "tui-stories";
      port = 6013;
    }
    {
      path = "packages/@overeng/notion-react";
      name = "notion-react";
      port = 6014;
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      port = 6015;
    }
    {
      path = "packages/@overeng/gh-ci-utils";
      name = "gh-ci-utils";
      port = 6016;
    }
  ];
  packagesWithNetlifyPreview = lib.filter (pkg: pkg.name != "tui-stories") packagesWithStorybook;
  # Repository-specific semantic inputs read by Genie sources. The shared
  # Genie module already owns the direct and nested `.genie.ts` census; this
  # single list is composed into both its warm fingerprint and lint freshness.
  genieExtraInputGlobs = [
    "context/otel-scrape/telemetry-registry.json"
    "genie/buck2/*.ts"
    "packages/@overeng/buck2-tools/src/**/*.ts"
    "packages/@overeng/megarepo/src/buck2-manifest.ts"
    "packages/@overeng/megarepo/src/composition/overlays/dist-overlay-schema.ts"
    "packages/@overeng/megarepo/src/composition/root/composition-root.ts"
    "packages/@overeng/tui-core/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.tsx"
    "packages/@overeng/tui-core/src/**/*.cts"
    "packages/@overeng/tui-core/src/**/*.mts"
    "packages/@overeng/tui-core/test/**/*.ts"
    "packages/@overeng/tui-core/test/**/*.tsx"
    "packages/@overeng/tui-core/test/**/*.cts"
    "packages/@overeng/tui-core/test/**/*.mts"
    "packages/@overeng/tui-react/src/**/*.ts"
    "packages/@overeng/tui-react/src/**/*.tsx"
    "packages/@overeng/tui-react/src/**/*.cts"
    "packages/@overeng/tui-react/src/**/*.mts"
    "packages/@overeng/tui-react/test/**/*.ts"
    "packages/@overeng/tui-react/test/**/*.tsx"
    "packages/@overeng/tui-react/test/**/*.cts"
    "packages/@overeng/tui-react/test/**/*.mts"
    "packages/@overeng/tui-react/examples/**/*.ts"
    "packages/@overeng/tui-react/examples/**/*.tsx"
    "packages/@overeng/tui-react/examples/**/*.cts"
    "packages/@overeng/tui-react/examples/**/*.mts"
    "packages/@overeng/utils/src/**/*.ts"
    "packages/@overeng/utils/src/**/*.tsx"
    "packages/@overeng/utils/src/**/*.cts"
    "packages/@overeng/utils/src/**/*.mts"
    "packages/@overeng/utils-dev/src/**/*.ts"
    "packages/@overeng/utils-dev/src/**/*.tsx"
    "packages/@overeng/utils-dev/src/**/*.cts"
    "packages/@overeng/utils-dev/src/**/*.mts"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
  # Single declaration for the source-generator import closure published before Genie can load.
  # genie:editor-view-closure:check walks every generator with the shared bootstrap closure checker
  # and fails when this list omits a first-party runtime package boundary.
  editorBootstrapRootPackagePath = "packages/@overeng/genie";
  editorBootstrapPackagePaths = [
    "."
    "packages/@overeng/otel-contract"
  ];
  buck2AggregateExec =
    taskName: target:
    trace.exec taskName ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${lib.makeBinPath [ pkgs.watchman ]}
      cd "$root"
      ${standaloneBuckCachePosture}

      # Keep native evidence per invocation, including failed builds. Capture setup and
      # telemetry must not prevent the direct Buck invocation or change its exit code.
      spool=""
      if ${pkgs.coreutils}/bin/mkdir -p "$root/.devenv/otel/buck2-events"; then
        spool="$(${pkgs.coreutils}/bin/mktemp -d "$root/.devenv/otel/buck2-events/${taskName}.XXXXXXXX")" || spool=""
      fi
      buck_args=(build ${lib.escapeShellArg target})
      unset BUCK_WRAPPER_UUID BUCK_COMMAND_SPAN_ID BUCK_COMMAND_START_NS \
        BUCK_COMMAND_TRACE_ID BUCK_COMMAND_PARENT_SPAN_ID
      if [ -n "$spool" ]; then
        event_log="$spool/command_events.pb.zst"
        sidecar="$spool/traceparent.sidecar"
        buck_args+=(--event-log "$event_log" --write-build-id "$spool/buck-trace-id")
        if prepared="$("''${OTEL_SPAN_BIN:-otel-span}" buck2 --sidecar "$sidecar")"; then
          eval "$prepared"
        fi
      fi

      if "$BUCK2_BIN" "''${buck_args[@]}"; then
        buck_exit=0
      else
        buck_exit=$?
      fi
      command_end_ns="$(${pkgs.coreutils}/bin/date +%s%N)" || command_end_ns=""
      if [ -n "''${BUCK_COMMAND_TRACE_ID:-}" ] && [ -n "$command_end_ns" ]; then
        command_status=ok
        if [ "$buck_exit" -ne 0 ]; then command_status=error; fi
        OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
          "''${OTEL_SPAN_BIN:-otel-span}" emit-span "effect-utils-devenv" "buck2.command build" \
          --trace-id "$BUCK_COMMAND_TRACE_ID" \
          --parent-span-id "$BUCK_COMMAND_PARENT_SPAN_ID" \
          --span-id "$BUCK_COMMAND_SPAN_ID" \
          --start-time-ns "$BUCK_COMMAND_START_NS" \
          --end-time-ns "$command_end_ns" \
          --status-code "$command_status" \
          --attr-int "exit.code=$buck_exit" || true
      fi
      if [ -n "$spool" ] && [ -s "$event_log" ]; then
        # Each OTLP request is bounded in the adapter; this outer cap also bounds
        # decode so a wedged collector or hostile log never holds the task.
        OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
          ${pkgs.coreutils}/bin/timeout -k 5 60 \
          ${repoPackages.buck2-events}/bin/buck2-events ingest "$event_log" --sidecar "$sidecar" || true
      fi
      exit "$buck_exit"
    '';
  editorViewExec =
    {
      mode,
      packagePaths ? null,
      traceScope ? null,
    }:
    let
      traceName = "buck2:editor:${mode}${lib.optionalString (traceScope != null) ":${traceScope}"}";
      packageArgument = lib.optionalString (
        packagePaths != null
      ) " --packages ${lib.escapeShellArg (builtins.toJSON packagePaths)}";
    in
    trace.exec traceName ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      ${standaloneBuckCachePosture}
      exec ${pkgs.bun}/bin/bun "$root/scripts/editor-view-authority.ts" ${mode} \
        --repo-root "$root" \
        --workspace-root "$root" \
        --cell effect_utils \
        --buck2 "$BUCK2_BIN" \
        --git ${pkgs.git}/bin/git \
        --output "$root/.devenv/editor-workspace-authority.json" \
        --publisher "$root/packages/@overeng/buck2-tools/src/editor-view.ts" \
        --cp ${pkgs.coreutils}/bin/cp \
        --mv ${pkgs.coreutils}/bin/mv \
        --fingerprint-tool ${repoFlake.packages.${currentSystem}.buck2-fingerprint}/bin/buck2-fingerprint \
        --snapshot-retention 3${packageArgument}
    '';
  scopedEditorViewPublisher =
    {
      description,
      packagePaths,
      traceScope,
    }:
    {
      inherit description;
      after = [ "genie:check" ];
      # trace-audit-allow: editorViewExec returns a trace.exec-wrapped command.
      exec = editorViewExec {
        mode = "publish";
        inherit packagePaths traceScope;
      };
    };
in
{
  imports = [
    # Git hook: prevent commits on default branch + enforce linked worktrees
    (taskModules.worktree-guard { })
    # OpenTelemetry observability stack (Collector + Tempo + Grafana)
    (import ./nix/devenv-modules/otel.nix { traceShellEntry = false; })
    # Hermetic native-devenv + effect-utils task-tree capture. Ambient mode
    # composes with the full stack above without importing it a second time.
    (import ./nix/devenv-modules/observability.nix {
      project = "effect-utils";
      # Shell-entry setup is intentionally absent. Profile an instantiated,
      # non-mutating task so check:all retains its trace integrity gate.
      profile = {
        name = "genie-check";
        task = "genie:check";
        mode = "single";
        smokeTask = "genie:check";
        smokeMode = "single";
        bridgeTask = "genie:check";
        # The verifier launches a nested, cache-refreshed task run. Keep it last
        # so its task-cache refresh cannot race sibling check:all work.
        prerequisiteTasks = [
          "buck2:providers:check"
          "cargo:check"
          "dependency-materialization:evidence:check"
          "check:devenv-eval-inputs"
          "lint:check"
          "nix:check:quick"
          "buck2:editor:publish"
          "test:run"
          "weaver:diff"
        ];
      };
      wireInto = [ "check:all" ];
    })
    # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels
    (import ./nix/devenv-modules/gh-labels.nix { repo = "overengineeringstudio/effect-utils"; })
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    (taskModules.megarepo {
      mrPkg = mrCli;
      disabledTasks = [
        "mr:setup"
        "mr:check"
        "mr:lock-sync-check"
        "mr:source-policy-check"
      ];
    })
    # Repository Nix checks validate the two artifact-import contracts; check:all adds full-flake
    # evaluation without realization. The from-source bridge contract realizes the retained
    # Megarepo recovery product, so it runs pre-merge in the PR-only `pr-a-inert-buck` CI lane
    # instead of either aggregate.
    (taskModules.check {
      hasMegarepoCheck = false;
      hasNixCheck = false;
      checkQuickTypecheckTask = "buck2:quick";
      checkAllTypecheckTask = "buck2:all";
      extraChecks = [ "nix:check:quick" ];
    })
    (taskModules.devenv-eval-input-budget { })

    # Compat-diff gate (SC-R11): blocks a PR that REMOVES a shipped registry attribute/signal.
    # PR-scoped (needs a merge-base baseline) — degrades to a warning locally on a fresh clone with
    # no `origin/main` merge-base; its load-bearing home is the CI `weaver` lane.
    (taskModules.weaver-diff { })
    { tasks."check:all".after = [ "weaver:diff" ]; }
    { tasks."check:all".after = [ "nix:flake:eval" ]; }
    # Live-check e2e (SC-R12): emits registry-conformant OTLP from a first-party site, captures it,
    # and asserts `weaver registry live-check` accepts it (exit 0). Runs the scoped vitest e2e with
    # the hermetic weaver + semconv-model on env; degrades to a warning if weaver is unavailable.
    # Defined here so the CI `weaver` lane can invoke it, but deliberately NOT wired into `check:all`:
    # unlike the deterministic check/diff runs, this is a subprocess e2e (spawns otelite, binds an
    # ephemeral port, depends on export-flush timing), so it lives in CI rather than gating every
    # local `check:all` on capture reliability.
    (taskModules.weaver-live-check { installTask = "buck2:editor:publish:otel-contract"; })
    (taskModules.clean { packages = allPackages; })
    # Pnpm remains only as a lockfile authoring tool. It cannot materialize a
    # workspace dependency graph or publish node_modules.
    (taskModules.pnpm {
      packages = allPackages;
      inherit pnpmPkg;
      materialize = false;
    })
    (taskModules.buck2-rust-deps { workspaceRoot = "rust"; })
    # Source-side Vitest is now only what Buck does not execute: packages outside the Buck
    # test registry and each admitted lane's exact excluded files. Retained JSON therefore
    # exists exactly where the baseline gate still needs a source report.
    (taskModules.test-playwright {
      playwrightPkg = inputs.playwright.packages.${currentSystem}.playwright;
      installTask = "buck2:editor:publish:playwright";
      # Launch the CLI through @playwright/test so the runner and test imports
      # share one module instance inside the Buck editor dependency view.
      playwrightBin = "node_modules/@playwright/test/cli.js";
      packages = [
        {
          path = "packages/@overeng/utils";
          name = "utils";
        }
        {
          path = "packages/@overeng/tui-react";
          name = "tui-react";
        }
      ];
    })
    (taskModules.test {
      installTask = "buck2:editor:publish";
      packages = sourceTestPackages;
      extraTests = [
        "devenv-modules:test"
        "genie:buck2:test"
      ];
      packageConcurrency = 4;
      retainVitestJson = true;
    })
    # Per-lane Buck `test:<package>` tasks, each pulling in its unbounded complement.
    { tasks = buck2TestLaneTasks; }
    (taskModules.storybook {
      installTask = "buck2:editor:publish";
      packages = packagesWithStorybook;
    })
    (taskModules.netlify {
      siteName = "overeng-utils";
      siteId = "462d2440-fb38-4e69-8023-9c425d1e2132";
      ciToolsBin = "${ciToolsCli}/bin/ci-tools";
      deployments = map (pkg: {
        name = pkg.name;
        staticDir = "${pkg.path}/storybook-static";
        afterTask = "storybook:build:${pkg.name}";
        workspaceFilter = true;
      }) packagesWithNetlifyPreview;
    })
    # Workflow reports run as standalone CI control-plane steps, including when
    # a deploy is skipped. Use the hermetic package instead of relying on an
    # ambient source-workspace node_modules projection.
    (taskModules.workflow-report { ciToolsBin = "${ciToolsCli}/bin/ci-tools"; })
    (taskModules.lint-oxc {
      oxlintPkg = oxlintWithPlugins;
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
      # Match both repo-root and nested Genie sources explicitly, then compose
      # the same repository-specific semantic inputs used by the warm-state
      # fingerprint. This is freshness scheduling, not output admission.
      geniePatterns = [
        "*.genie.ts"
        "**/*.genie.ts"
      ]
      ++ genieExtraInputGlobs;
      genieCoverageDirs = [ "packages" ];
      # Type correctness is owned by the Buck aggregate; lint stays a syntax and
      # source-policy pass instead of reconstructing a second root TS solution.
      # Warning cleanup is complete, so any lint warning fails both CI and the
      # local pre-commit gate.
      denyWarnings = true;
    })
    # Setup task (auto-runs in enterShell)
    # Context example tasks
    taskModules.context
    (taskModules.setup {
      # Repository mutation is explicit. Shell entry activates only the Nix
      # environment, so its latency and availability are independent of Buck,
      # pnpm, Genie, megarepo state, and the repository revision.
      runOnEnterShell = false;
      requiredTasks = [ ];
      # Reuse the Genie semantic-input SSOT in the cheap Git-index outer
      # fingerprint so a warm shell cannot bypass projection invalidation.
      extraFingerprintGlobs = genieExtraInputGlobs;
      # Run the one ordered mutating entrypoint. Its internal task sequence
      # preserves generator/freshness/publication happens-before.
      optionalTasks = [ "buck2:editor:materialize" ];
      completionsCliNames = [
        "genie"
        "mr"
      ];
    })
    (taskModules.secretspec { })
    taskModules.devenv-module-tests
    # Notion integration tests (requires NOTION_API_TOKEN)
    ./nix/devenv-modules/tasks/local/notion-integration-test.nix
    # Restate integration tests (native restate-server via RESTATE_SERVER_BIN)
    ./nix/devenv-modules/tasks/local/restate-integration-test.nix
  ];

  # The guarded `genie` command dispatches to this repository's own packaged
  # Genie product, which is also what downstream consumers set here.
  effectUtils.genie.package = genieCli;

  # The packaged Genie CLI is self-contained; generator sources resolve their
  # external imports through the committed-graph bootstrap editor views. This
  # stage-zero publication cannot report governed Buck evidence: the closure
  # checker first proves that the declared publication set covers every
  # first-party runtime boundary, then genie:check proves the tracked standalone
  # graph fresh and the authoritative publisher replays it.
  tasks."genie:run".after = [ "genie:editor-view-closure:check" ];
  tasks."genie:check".after = lib.mkForce [
    "genie:prepare"
    "genie:editor-view-closure:check"
  ];
  tasks."lint:check:genie".after = [ "genie:editor-view-closure:check" ];
  tasks."genie:watch".after = [ "genie:editor-view-closure:check" ];
  tasks."lint:check:lockfile".description =
    lib.mkForce "Verify lockfile and package specifiers through source-side Genie freshness";
  tasks."lint:check:lockfile".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check:lockfile".exec = lib.mkForce (
    trace.exec "lint:check:lockfile" "exec genie --check"
  );
  tasks."lint:fix:oxlint".after = [ "buck2:editor:publish" ];
  tasks."devenv-modules:test".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:restate-integration".after = lib.mkForce [ "buck2:editor:publish:restate-effect" ];
  tasks."test:notion-integration:notion-effect-client".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-cli".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-datasource-sync".after = lib.mkForce [
    "buck2:editor:publish"
  ];
  tasks."test:notion-integration:notion-md".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-react".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."weaver:live-check".after = lib.mkForce [ "buck2:editor:publish:otel-contract" ];
  tasks."test:pty-effect:unbounded".env = {
    NODE_PTY_NATIVE_PACKAGE = "${nodePtyNative}/node_modules/node-pty";
    NODE_OPTIONS = "--import=${./. + "/packages/@overeng/pty-effect/test/node-pty-native-hook.ts"}";
  };

  tasks."lint:check:format".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check:format".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:format";
    targets = [ "effect_utils//buck2/static:check_format" ];
  });
  tasks."lint:check:oxlint".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check:oxlint".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:oxlint";
    targets = [ "effect_utils//buck2/static:check_lint" ];
  });
  tasks."lint:check:genie:coverage".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check:genie:coverage".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:genie:coverage";
    targets = [ "effect_utils//buck2/static:check_policy" ];
  });

  # The outer devenv verb preserves stage-zero Genie freshness, then delegates
  # every deterministic repository validation to Buck's static aggregate.
  tasks."lint:check".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check";
    targets = [ "effect_utils//buck2/static:check" ];
  });

  # Non-`.genie.ts` sources share one list with the lint freshness scheduler.
  effectUtils.genie.extraInputGlobs = genieExtraInputGlobs;

  packages = [
    buck2Stage0Definition.archive-tool
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    pkgs.flock # Cross-process locking for setup tasks (see setup.nix)
    # Buck's admitted event backend; avoids pnpm alias staleness and whole-tree
    # crawler races under concurrent repository tools.
    pkgs.watchman
    # restate-server (+ restate CLI) on $PATH for restate-effect integration tests.
    restate
    # Use the packaged wrapper so `notion db ...` runs on Node 24 with node:sqlite.
    repoPackages.notion-cli
    # Rust binaries on PATH for local smoke tests and downstream wrappers.
    repoPackages.otelite
    repoPackages.otel-scrape
    repoPackages.buck2-events
    # Nix-distributed Buck binary used by direct repository tasks.
    buck2Machine
    buck2Stage0Definition.product
    cliBuildStamp.package
    ciToolsCli
    ghCiUtilsCli
    tuiStoriesCli
    # Rust toolchain for the standalone Rust crates.
    # Stage-zero Nix providers use pkgs.rustPlatform; local validation keeps
    # cargo/clippy/rustfmt/rust-analyzer aligned with nixpkgs' stable Rust.
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.reindeer
    pkgs.rustfmt
    pkgs.rust-analyzer
  ];

  # actionlint binary path for genie's workflow validation (also used by tests)
  env.GENIE_ACTIONLINT_BIN = "${pkgs.actionlint}/bin/actionlint";
  env.BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.BUCK2_MACHINE_VERSION = buck2Machine.version;
  # Source-mode mr must receive the same pinned composition runtime as the
  # packaged wrapper; refreshed tasks can invoke composition from owned members.
  env.MR_COMPOSITION_CP_BIN = "${pkgs.coreutils}/bin/cp";
  env.MR_COMPOSITION_BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.MR_COMPOSITION_BUCK2_PROTOCOL = "facebook/buck2-cli/2026-09-01";
  env.MR_COMPOSITION_SYSTEM = currentSystem;
  env.MR_COMPOSITION_PLATFORM = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  env.MR_COMPOSITION_GIT_BIN = "${pkgs.git}/bin/git";
  env.MR_COMPOSITION_WATCHMAN_BIN = "${pkgs.watchman}/bin/watchman";
  env.MR_CAPABILITY_NIX_BIN = "${pkgs.nix}/bin/nix";
  env.MR_CAPABILITY_PROJECTION = "${buck2Capabilities}";
  env.MR_CAPABILITY_MV_BIN = "${pkgs.coreutils}/bin/mv";

  # restate-server binary path for restate-effect integration tests (test/test-utils.ts
  # reads RESTATE_SERVER_BIN to locate the native server, else falls back to $PATH).
  env.RESTATE_SERVER_BIN = "${restate}/bin/restate-server";

  # Repository composition remains an explicit mr operation. Generated-source freshness
  # is its only repository-local prerequisite; the check aggregates do not invoke it.
  tasks."mr:apply".after = [ "genie:check" ];

  # buck2-tools executes inside pinned Bun actions and exercises Bun.YAML/Bun.which.
  # Keep its package gate on that runtime rather than Vitest's Node process.
  tasks."test:buck2-tools".description = lib.mkForce "Run buck2-tools tests under pinned Bun";
  tasks."test:buck2-tools".exec = lib.mkForce (
    trace.exec "test:buck2-tools" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export CP_BIN=${pkgs.coreutils}/bin/cp
      export MV_BIN=${pkgs.coreutils}/bin/mv
      export FALSE_BIN=${pkgs.coreutils}/bin/false
      export FINGERPRINT_BIN=${repoFlake.packages.${currentSystem}.buck2-fingerprint}/bin/buck2-fingerprint
      export BUCK2_FINGERPRINT_TOOL="$FINGERPRINT_BIN"
      cd "$root/packages/@overeng/buck2-tools"
      exec ${pkgs.bun}/bin/bun test src/*.test.ts
    ''
  );

  # The Buck2 genie projection suite lives outside packages/@overeng, so the
  # per-package `test:<pkg>` tasks and the root Vitest projects list both miss
  # it. Give it its own task and hang it off `test:run`, or the projection and
  # staged-runtime guards never run. Like test:buck2-tools it runs under pinned
  # Bun: the pnpm-lock projection it imports reads Bun.YAML.
  tasks."genie:buck2:test" = {
    description = "Run the Buck2 genie projection and staged-runtime guards under pinned Bun";
    after = [ "buck2:editor:publish" ];
    exec = trace.exec "genie:buck2:test" ''
      set -euo pipefail
      cd "''${DEVENV_ROOT:-$PWD}"
      # Directory, not a flat glob: genie/buck2/vitest.config.ts includes
      # `**/*.unit.test.ts`, and Bun discovers recursively the same way.
      exec ${pkgs.bun}/bin/bun test genie/buck2/
    '';
    execIfModified = [
      "BUCK"
      "genie/buck2/**/*.ts"
      "genie/buck2/fixtures/**/*"
      "rust/buck2-tools/core/cargo-buck2-package-projection.ts"
      "packages/@overeng/buck2-tools/src/**/*.ts"
    ];
  };

  # Empirical authority for the minimal generator phase that must run before
  # any dependency view exists. The design-time source closure is proven by
  # buck2:editor:bootstrap followed by genie:check.
  tasks."bootstrap:cold-proof" = {
    description = "Prove the marked bootstrap Genie generators run without node_modules";
    exec = trace.exec "bootstrap:cold-proof" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec bash "$root/genie/ci-scripts/bootstrap-cold-proof.sh"
    '';
  };

  tasks."test:megarepo-cold-gc" = {
    after = [ "buck2:editor:publish" ];
    description = "Run fixture-isolated megarepo cold-GC integration tests from the standalone checkout";
    cwd = "packages/@overeng/megarepo";
    exec = trace.exec "test:megarepo-cold-gc" ''
      set -euo pipefail
      source ${lib.escapeShellArg pnpmTaskHelpersScript}
      run_package_bin vitest vitest run src/cli/store-gc-cold.integration.test.ts --reporter verbose --testTimeout 240000
    '';
    execIfModified = [
      "packages/@overeng/megarepo/src/**/*.ts"
      "packages/@overeng/megarepo/src/**/*.tsx"
      "packages/@overeng/megarepo/vitest.config.ts"
    ];
  };

  tasks."bundle:smoke" = {
    after = [ "genie:check" ];
    description = "Bundle representative public entries through Buck with Vite/Rollup";
    # trace-audit-allow: buck2UnitTestExec returns a trace.exec-wrapped command.
    exec = buck2UnitTestExec {
      name = "bundle:smoke";
      targets = [ "effect_utils//packages/@overeng/pty-effect:bundle_smoke" ];
    };
  };

  tasks."gh:apply-settings" = {
    after = [ "genie:run" ];
    exec = trace.exec "gh:apply-settings" ''
      set -euo pipefail
      ruleset_id=$(gh api repos/overengineeringstudio/effect-utils/rulesets --jq '.[0].id')
      gh api "repos/overengineeringstudio/effect-utils/rulesets/$ruleset_id" --method PUT --input .github/repo-settings.json
      echo "Applied repo-settings.json to ruleset $ruleset_id"
    '';
    description = "Apply .github/repo-settings.json to GitHub ruleset";
  };

  tasks."cargo:test:buck2-foundation" = {
    description = "Run the Rust tests for the Buck2 foundation tools";
    exec = trace.exec "cargo:test:buck2-foundation" ''
      set -euo pipefail
      (
        cd rust
        cargo test --locked --package 'buck2-*'
      )
    '';
  };

  tasks."cargo:check" = {
    description = "Test, lint, and format-check the shared Cargo workspace";
    after = [
      "cargo:test:buck2-foundation"
      "cargo:proto-bindings:check"
    ];
    exec = trace.exec "cargo:check" ''
      set -euo pipefail
      (
        cd rust
        cargo test --locked --workspace --exclude 'buck2-*'
        cargo clippy --locked --workspace --all-targets -- -D warnings
        cargo fmt --all --check
      )
    '';
  };

  tasks."cargo:proto-bindings:check" = {
    description = "Check the committed buck2-events prost bindings against the vendored Buck2 protos";
    exec = trace.exec "cargo:proto-bindings:check" ''
      set -euo pipefail
      cargo run --quiet --locked \
        --manifest-path rust/buck2-tools/events/proto/generate/Cargo.toml \
        --target-dir rust/target/proto-generate -- --check
    '';
  };

  tasks."dependency-materialization:evidence:check" = {
    description = "Validate committed dependency-materialization benchmark and host-capability evidence";
    exec = trace.exec "dependency-materialization:evidence:check" ''
      ${pkgs.nodejs}/bin/node \
        context/dependency-materialization/07-verification/evidence/validate-storage-sharing-default.mjs
    '';
  };

  tasks."buck2:archives:seed" = {
    description = "Verify and idempotently seed lockfile archives into the configured CAS tier";
    after = [ "genie:check" ];
    exec = trace.exec "buck2:archives:seed" ''
      set -euo pipefail
      exec ${pkgs.bun}/bin/bun buck2/dependencies/seed-archives.ts
    '';
  };

  tasks."nix:buck2-artifact-import:check" = {
    description = "Check the generic Buck product descriptor and artifact-import contracts";
    after = [ "genie:check" ];
    exec = trace.exec "nix:buck2-artifact-import:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-build-product-contract.sh "$PWD"
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-bridge.sh "$PWD"
    '';
  };

  tasks."nix:javascript-product-import:check" = {
    description = "Check JavaScript Buck product descriptor and artifact-import contracts";
    after = [ "genie:check" ];
    exec = trace.exec "nix:javascript-product-import:check" ''
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/javascript-product-import.sh "$PWD"
    '';
  };

  tasks."nix:check:quick" = {
    description = "Check Nix artifact-import contracts without realizing repository products";
    after = [
      "nix:buck2-artifact-import:check"
      "nix:javascript-product-import:check"
    ];
  };

  # Replaces the former `nix flake check` edge: every flake output for the host system is
  # evaluated, but nothing is realized, so repository-source products stay out of the Nix checks.
  tasks."nix:flake:eval" = {
    description = "Evaluate every flake output for the host system without building";
    after = [ "genie:check" ];
    exec = trace.exec "nix:flake:eval" "${pkgs.nix}/bin/nix flake check --no-build";
  };

  tasks."buck2:nix-bridge:check" = {
    description = "Check the cache publisher and retained Megarepo from-source fallback";
    after = lib.mkForce [ "genie:check" ];
    exec = trace.exec "buck2:nix-bridge:check" ''
      set -euo pipefail
      BUCK2_PRODUCTS_BUN=${pkgs.bun}/bin/bun \
        ${pkgs.bash}/bin/bash nix/buck2-products/from-source-contract.test.sh "$PWD"
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-release-products.sh "$PWD"
    '';
  };

  tasks."buck2:editor:bootstrap" = {
    description = "Bootstrap source-generator dependencies from the committed standalone Buck graph";
    # trace-audit-allow: editorViewExec returns a trace.exec-wrapped command.
    exec = editorViewExec {
      mode = "bootstrap";
      packagePaths = editorBootstrapPackagePaths;
    };
  };

  tasks."genie:editor-view-closure:check" = {
    description = "Prove the bootstrap editor views cover every generator runtime package boundary";
    after = [ "buck2:editor:bootstrap" ];
    exec = trace.exec "genie:editor-view-closure:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bun}/bin/bun "$root/genie/ci-scripts/bootstrap-closure-check.ts" \
        --root "$root" \
        --editor-view-root-package-path ${lib.escapeShellArg editorBootstrapRootPackagePath} \
        --editor-view-package-paths ${lib.escapeShellArg (builtins.toJSON editorBootstrapPackagePaths)}
    '';
  };

  # Authoring and declaration publication need generated projections to be
  # updated before freshness is checked, but standalone genie:check must remain
  # mutation-free. Keep that mutating sequence in one explicit entrypoint.
  tasks."buck2:editor:materialize" = {
    description = "Regenerate, freshness-check, and publish every editor dependency view in order";
    exec = trace.exec "buck2:editor:materialize" ''
      set -euo pipefail
      export DEVENV_TUI=false
      devenv tasks run buck2:editor:bootstrap --mode single
      devenv tasks run genie:run --mode single
      devenv tasks run genie:check --mode single
      devenv tasks run buck2:editor:publish --mode single
    '';
  };

  tasks."buck2:editor:authority" = {
    description = "Prove complete Buck ownership of every workspace editor dependency view";
    after = [ "genie:check" ];
    # trace-audit-allow: editorViewExec returns a trace.exec-wrapped command.
    exec = editorViewExec { mode = "authority"; };
  };

  tasks."buck2:editor:publish" = {
    description = "Atomically publish every Buck-owned workspace editor dependency view";
    after = [ "genie:check" ];
    # trace-audit-allow: editorViewExec returns a trace.exec-wrapped command.
    exec = editorViewExec { mode = "publish"; };
  };

  tasks."buck2:editor:publish:restate-effect" = scopedEditorViewPublisher {
    description = "Atomically publish the Restate integration editor dependency view";
    packagePaths = [ "packages/@overeng/restate-effect" ];
    traceScope = "restate-effect";
  };

  tasks."buck2:editor:publish:otel-contract" = scopedEditorViewPublisher {
    description = "Atomically publish the Weaver live-check editor dependency view";
    packagePaths = [ "packages/@overeng/otel-contract" ];
    traceScope = "otel-contract";
  };

  tasks."buck2:editor:publish:playwright" = scopedEditorViewPublisher {
    description = "Atomically publish the shared Playwright editor dependency views";
    packagePaths = [
      "packages/@overeng/tui-react"
      "packages/@overeng/utils"
    ];
    traceScope = "playwright";
  };

  tasks."buck2:editor:check" = {
    description = "Fail when any published workspace editor dependency view is stale";
    after = [ "genie:check" ];
    # trace-audit-allow: editorViewExec returns a trace.exec-wrapped command.
    exec = editorViewExec { mode = "check"; };
  };

  tasks."buck2:editor:recover-lock" = {
    description = "Recover the shared editor publication lock with its exact owner token";
    exec = trace.exec "buck2:editor:recover-lock" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      package="''${EDITOR_VIEW_PACKAGE:?set EDITOR_VIEW_PACKAGE to a workspace package path}"
      token="''${EDITOR_VIEW_LOCK_TOKEN:?set EDITOR_VIEW_LOCK_TOKEN to the owner token printed by publish}"
      ${pkgs.bun}/bin/bun "$root/packages/@overeng/buck2-tools/src/editor-view.ts" recover-lock \
        --repo-root "$root" \
        --package "$package" \
        --token "$token"
    '';
  };

  tasks."buck2:typescript:materialize-dist" = {
    description = "Atomically materialize all Buck-owned TypeScript declarations";
    after = [ "buck2:editor:materialize" ];
    exec = trace.exec "buck2:typescript:materialize-dist" ''
      set -euo pipefail
      ${typescriptPublicationRootPredicate}
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      export WORKSPACE_ROOT="$root"
      workspace_root="$(typescript_publication_workspace_root "$root")" || {
        identity_status=$?
        echo "buck2:typescript:materialize-dist requires a composed" \
          "megarepo workspace or a standalone Buck root" >&2
        exit "$identity_status"
      }
      if [ "$workspace_root" != "$root" ]; then
        export WORKSPACE_ROOT="$workspace_root"
        export BUCK2_BIN="$workspace_root/.megarepo/bin/"buck2
      fi
      exec ${pkgs.bun}/bin/bun "$root/genie/buck2/typescript-authority-runtime.ts" \
        materialize-dist "$root" "$workspace_root" "$BUCK2_BIN" \
        ${pkgs.coreutils}/bin/mv ${pkgs.coreutils}/bin/chmod
    '';
  };

  tasks."buck2:task-guards:check" = {
    description = "Check evaluated Buck task ordering and standalone boundaries";
    exec = trace.exec "buck2:task-guards:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      DEVENV_TASKS_JSON="$root/.devenv/gc/task-config-devenv-config-task-config" \
        NODE_BIN=${pkgs.nodejs}/bin/node exec ${pkgs.bash}/bin/bash \
        "$root/nix/devenv-modules/tasks/shared/tests/devenv-task-graph.test.sh"
    '';
  };

  tasks."check:buck2-producer-overlap" = {
    description = "Reject duplicate Buck and legacy TypeScript producers";
    after = [ "genie:check" ];
    exec = trace.exec "check:buck2-producer-overlap" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bun}/bin/bun "$root/genie/buck2/producer-overlap.ts" check \
        "$root/.devenv/gc/task-config-devenv-config-task-config"
    '';
  };

  # The provider audit remains separate because it validates the
  # capability/toolchain boundary rather than producing an admitted artifact.
  tasks."buck2:providers:check" = {
    description = "Audit cross-cell provider identity for configured Buck toolchains";
    # `genie:check` waits for `buck2:editor:bootstrap`, which hashes Buck outputs. Aggregates
    # that materialize into `buck-out` must not run concurrently with that hashing; before
    # #1362 the removed `buck2:nix-bridge:check` edge provided this ordering transitively.
    after = [
      "genie:check"
      "buck2:task-guards:check"
      "buck2:rust-deps:check"
    ];
    exec = trace.exec "buck2:providers:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${lib.makeBinPath [ pkgs.watchman ]}
      cd "$root"
      exec "$BUCK2_BIN" audit providers \
        --target-platforms //buck2/platforms:host_platform \
        //buck2/toolchains:cross_cell_provider_identity \
        //buck2/toolchains:cross_cell_product_identity
    '';
  };

  tasks."buck2:quick" = {
    description = "Build the admitted quick Buck aggregate";
    after = [ "buck2:providers:check" ];
    # trace-audit-allow: buck2AggregateExec returns a trace.exec-wrapped command.
    exec = buck2AggregateExec "buck2:quick" "//:quick";
  };

  tasks."buck2:all" = {
    description = "Build the complete admitted Buck aggregate";
    after = [ "buck2:providers:check" ];
    # trace-audit-allow: buck2AggregateExec returns a trace.exec-wrapped command.
    exec = buck2AggregateExec "buck2:all" "//:all";
  };

  tasks."check:quick".after = lib.mkForce [
    "buck2:quick"
    "cargo:proto-bindings:check"
    "check:buck2-producer-overlap"
    "nix:check:quick"
  ];
  # One Buck invocation executes every admitted bounded lane. This is what `test:run` waits on;
  # the per-lane `test:<package>` tasks (imported above) exist for standalone use and are not
  # part of that graph, so no suite is scheduled twice.
  tasks."test:buck2:unit" = {
    description = "Execute every admitted bounded unit-test lane under Buck";
    after = [ "genie:check" ];
    # trace-audit-allow: buck2UnitTestExec returns a trace.exec-wrapped command.
    exec = buck2UnitTestExec {
      name = "test:buck2:unit";
      targets = map (lane: lane.target) buck2TestLanes;
    };
  };
  tasks."check:all".after = [
    "check:buck2-producer-overlap"
    "cargo:check"
    "dependency-materialization:evidence:check"
  ];

  # `test:run` is the aggregate: the single Buck invocation for every bounded lane, plus the
  # source-only and unbounded-complement Vitest tasks the shared module wired into its `after`.
  # The baseline-collection gate then runs last and reads both kinds of evidence.
  tasks."test:run".after = [ "test:buck2:unit" ];
  tasks."test:run".exec = lib.mkForce (
    trace.exec "test:run" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      exec ${pkgs.bun}/bin/bun "$root/packages/@overeng/utils-dev/src/check-baseline-test-collection.ts" \
        --root "$root" \
        --buck2 "$BUCK2_BIN" \
        --buck2-cwd "$root"
    ''
  );

  # Keep git-hook installation out of the shell-entry path.
  # If needed, install with `devenv tasks run devenv:git-hooks:install`.
  # TODO(cachix/git-hooks.nix#688): remove this once the upstream git-hooks.nix issue
  # is fixed; currently this workaround prevents shell-entry failures with core.hooksPath.
  tasks."devenv:git-hooks:install".before = lib.mkForce [ ];

  # Repo-local pnpm store for consistent local installs (not used by Nix builds).
  env.PNPM_STORE_DIR = "${config.devenv.root}/.devenv/pnpm-store-pure-v1";

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    # Buck2 expands the cache header in the daemon; keep the optional credential
    # defined so unauthenticated cache reads work when SecretSpec is not active.
    export BUCK2_REMOTE_CACHE_BASIC_AUTH="''${BUCK2_REMOTE_CACHE_BASIC_AUTH:-}"
    capability_parent="$WORKSPACE_ROOT/.buck2"
    capability_link="$capability_parent/capabilities"
    ${pkgs.coreutils}/bin/mkdir -p "$capability_parent"
    if [ -e "$capability_link" ] && [ ! -L "$capability_link" ]; then
      ${pkgs.coreutils}/bin/rm -rf -- "$capability_link"
    fi
    ${pkgs.coreutils}/bin/ln -sfnT ${buck2Capabilities} "$capability_link"
    ${cliBuildStamp.shellHook}
  '';

  git-hooks.enable = true;
  git-hooks.hooks.check-quick = {
    enable = true;
    entry = "DEVENV_TUI=false devenv tasks run check:quick";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
