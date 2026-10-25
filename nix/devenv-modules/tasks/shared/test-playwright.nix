# Playwright e2e test tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.test-playwright {
#       packages = [
#         { path = "apps/misc.schickling.dev"; name = "misc"; installName = "misc-schickling-dev"; }
#       ];
#       # Optional: install task name (default: "pnpm:install")
#       installTask = "pnpm:install";
#       # Optional: custom playwright binary (default: playwright)
#       playwrightBin = "node_modules/.bin/playwright";
#     })
#   ];
#
# Provides:
#   - test:pw:run - Run all playwright tests
#   - test:pw:<name> - Run playwright tests for specific package
#   - Per-package isolateNetwork = true confines localhost-only suites to a
#     Linux user/network namespace when the host permits unprivileged namespaces.
{
  packages,
  installTask ? "pnpm:install",
  playwrightBin ? "playwright",
  playwrightPkg ? null,
  sourceLauncher ? null,
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  leaseSource =
    script:
    if sourceLauncher == null then
      script
    else
      ''
        exec ${sourceLauncher} ${pkgs.writeShellScript "leased-playwright-test" script}
      '';

  mkTestTask =
    pkg:
    let
      runTests = pkgs.writeShellScript "playwright-${pkg.name}" ''
        set -euo pipefail
        ${playwrightBin} test
      '';
      isolatedTests = pkgs.writeShellScript "playwright-${pkg.name}-network" ''
        set -euo pipefail
        ${pkgs.iproute2}/bin/ip link set lo up
        export PLAYWRIGHT_NETWORK_ISOLATED=1
        exec ${runTests}
      '';
      isolateNetwork = pkg.isolateNetwork or false;
    in
    {
      "test:pw:${pkg.name}" = {
        description = "Run playwright tests for ${pkg.name}";
        # Storybook and Vite otherwise discover caches below node_modules inside
        # the immutable Buck editor view and fail before Playwright can start.
        # Same per-checkout location as the storybook task module.
        exec = trace.exec "test:pw:${pkg.name}" (leaseSource ''
          export CACHE_DIR=${lib.escapeShellArg "${config.devenv.root}/.devenv/storybook-cache/${pkg.name}"}
          export VITE_CACHE_DIR=${lib.escapeShellArg "${config.devenv.root}/.devenv/vite-cache/${pkg.name}"}
          ${
            if isolateNetwork then
              if pkgs.stdenv.hostPlatform.isLinux then
                ''
                  if ${pkgs.util-linux}/bin/unshare -Urn true 2>/dev/null; then
                    exec ${pkgs.util-linux}/bin/unshare -Urn ${isolatedTests}
                  fi
                  echo "Playwright network isolation off: unprivileged user/network namespaces unavailable" >&2
                ''
              else
                ''
                  echo "Playwright network isolation off: supported only on Linux" >&2
                ''
            else
              ""
          }
          exec ${runTests}
        '');
        cwd = pkg.path;
        after = [ installTask ];
      };
    };

  guardedTasks = {
    "test:pw:run" = {
      guard = playwrightBin;
      description = "Run all playwright e2e tests";
      after = map (pkg: "test:pw:${pkg.name}") packages;
    };
  };

in
{
  packages = cliGuard.fromTasks {
    tasks = guardedTasks;
    reals = lib.optionalAttrs (playwrightPkg != null) { playwright = playwrightPkg; };
  };

  tasks = lib.mkMerge (
    map (pkg: cliGuard.stripGuards (mkTestTask pkg)) packages ++ [ (cliGuard.stripGuards guardedTasks) ]
  );
}
