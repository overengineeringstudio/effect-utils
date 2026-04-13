# Netlify deploy tasks for storybook packages
#
# Deploys storybook builds to a single Netlify site using per-package aliases.
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.netlify {
#       site = "my-netlify-site";
#       packages = [
#         { path = "packages/@overeng/tui-react"; name = "tui-react"; }
#         { path = "packages/@overeng/megarepo"; name = "megarepo"; }
#       ];
#     })
#   ];
#
# Deploy modes (via --input):
#   dt storybook:build:tui-react && dt netlify:deploy:tui-react                          # draft (unique URL)
#   dt storybook:build:tui-react && dt netlify:deploy:tui-react --input type=prod        # prod alias
#   dt storybook:build:tui-react && dt netlify:deploy:tui-react --input type=pr --input pr=42  # PR preview alias
#
# Provides:
#   Tasks:
#     - netlify:deploy:<name> - Deploy storybook for specific package
#     - netlify:deploy        - Aggregate: deploy all storybooks
#
# NOTE: pkg.name must be a valid Netlify alias slug (lowercase, alphanumeric, hyphens only).
{
  packages ? [ ],
  site, # Required — Netlify site name (e.g. "overeng-utils")
  buildTaskPrefix ? "storybook:build",
}:
{ lib, pkgs, ... }:
let
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  git = "${pkgs.git}/bin/git";
  hasPackages = packages != [ ];

  mkDeployTask = pkg: {
    "netlify:deploy:${pkg.name}" = {
      description = "Deploy ${pkg.name} storybook to Netlify";
      # Ensure the storybook exists before deploying.
      # `dt` runs tasks in "before" mode by default, so this will build first in CI and locally.
      after = [ "${buildTaskPrefix}:${pkg.name}" ];
      exec = ''
        set -euo pipefail

        if [ -z "''${NETLIFY_AUTH_TOKEN:-}" ]; then
          echo "Error: NETLIFY_AUTH_TOKEN is not set." >&2
          echo "Set it via: export NETLIFY_AUTH_TOKEN=\$(op read 'op://...')" >&2
          exit 1
        fi

        deploy_dir="${pkg.path}/storybook-static"
        workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' "${pkg.path}/package.json")"

        if [ ! -d "$deploy_dir" ]; then
          echo "Skipping ${pkg.name}: no build output at $deploy_dir" >&2
          echo "Run 'dt ${buildTaskPrefix}:${pkg.name}' first." >&2
          exit 0
        fi

        # Parse deploy context from DEVENV_TASK_INPUT (set by devenv --input flag)
        input="''${DEVENV_TASK_INPUT:-"{}"}"
        deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "draft"')"
        short_sha="$(${git} rev-parse --short HEAD 2>/dev/null || echo "unknown")"

        alias_flag=""
        alias_name=""
        filter_flag=""
        message="${pkg.name}"

        case "$deploy_type" in
          prod)
            alias_name="${pkg.name}"
            alias_flag="--alias=${pkg.name}"
            message="${pkg.name} (prod, $short_sha)"
            ;;
          pr)
            pr_number="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.pr // empty')"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            alias_name="${pkg.name}-pr-''${pr_number}"
            alias_flag="--alias=$alias_name"
            message="${pkg.name} (PR #''${pr_number}, $short_sha)"
            ;;
          draft)
            message="${pkg.name} (draft, $short_sha)"
            ;;
          *)
            echo "Error: Unknown deploy type '$deploy_type'. Use: prod, pr, draft" >&2
            exit 1
            ;;
        esac

        if [ -n "$workspace_filter" ]; then
          filter_flag="--filter=$workspace_filter"
        fi

        echo "Deploying ${pkg.name} ($deploy_type)..."

        # pnpm 11 requires explicit --allow-build for packages with native deps
        deploy_log="$(mktemp)"
        # shellcheck disable=SC2086
        pnpm --package=netlify-cli dlx \
          --allow-build=sharp \
          --allow-build=esbuild \
          --allow-build=unix-dgram \
          --allow-build=@parcel/watcher \
          netlify deploy \
          --dir="$deploy_dir" \
          --site="${site}" \
          $filter_flag \
          --no-build \
          $alias_flag \
          --message="$message" 2>&1 | tee "$deploy_log"

        deploy_exit="''${PIPESTATUS[0]}"
        if [ "$deploy_exit" -ne 0 ]; then
          rm -f "$deploy_log"
          exit "$deploy_exit"
        fi

        deploy_id="$(${pkgs.gnugrep}/bin/grep -Eo 'https://app.netlify.com/sites/[^[:space:]]+/deploys/[A-Za-z0-9]+' "$deploy_log" | ${pkgs.gnused}/bin/sed -E 's#.*/deploys/##' | tail -n 1 || true)"
        logged_unique_url="$(${pkgs.gnugrep}/bin/grep -Eo 'Unique deploy URL:[[:space:]]+https://[^[:space:]]+' "$deploy_log" | ${pkgs.gnused}/bin/sed -E 's/^Unique deploy URL:[[:space:]]+//' | tail -n 1 || true)"
        logged_website_url="$(${pkgs.gnugrep}/bin/grep -Eo 'Website( Draft)? URL:[[:space:]]+https://[^[:space:]]+' "$deploy_log" | ${pkgs.gnused}/bin/sed -E 's/^Website( Draft)? URL:[[:space:]]+//' | tail -n 1 || true)"

        raw_deploy_url="$logged_unique_url"
        if [ -z "$raw_deploy_url" ] && [ -n "$deploy_id" ]; then
          raw_deploy_url="https://$deploy_id--${site}.netlify.app"
        fi
        if [ -z "$raw_deploy_url" ]; then
          echo "Error: Could not determine unique Netlify deploy URL for ${pkg.name}" >&2
          cat "$deploy_log" >&2
          rm -f "$deploy_log"
          exit 1
        fi

        final_url="$logged_website_url"
        if [ -n "$alias_name" ]; then
          final_url="https://$alias_name--${site}.netlify.app"
        fi
        if [ -z "$final_url" ]; then
          final_url="$raw_deploy_url"
        fi

        deployed_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        deploy_metadata_json="$(${pkgs.jq}/bin/jq -cn --arg packageName '${pkg.name}' --arg rawDeployUrl "$raw_deploy_url" --arg finalUrl "$final_url" --arg deployedAtUtc "$deployed_at_utc" '{packageName: $packageName, rawDeployUrl: $rawDeployUrl, finalUrl: $finalUrl, deployedAtUtc: $deployedAtUtc}')"
        echo "Netlify deploy package: ${pkg.name}"
        echo "Netlify raw deploy URL: $raw_deploy_url"
        echo "Netlify deploy URL: $final_url"
        echo "Netlify deployed at UTC: $deployed_at_utc"
        echo "NETLIFY_DEPLOY_METADATA: $deploy_metadata_json"
        rm -f "$deploy_log"
      '';
    };
  };

in
{
  tasks = lib.mkMerge (
    (if hasPackages then map (pkg: cliGuard.stripGuards (mkDeployTask pkg)) packages else [ ])
    ++ [
      (cliGuard.stripGuards {
        "netlify:deploy" = {
          description = "Deploy all storybooks to Netlify";
          exec = null;
          after = if hasPackages then map (pkg: "netlify:deploy:${pkg.name}") packages else [ ];
        };
      })
    ]
  );
}
