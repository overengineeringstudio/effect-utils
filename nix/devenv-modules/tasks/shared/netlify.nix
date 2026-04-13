# Netlify deploy tasks for storybook packages
#
# Deploys storybook builds to a single Netlify site using per-package aliases.
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.netlify {
#       siteName = "my-netlify-site";
#       siteId = "01234567-89ab-cdef-0123-456789abcdef";
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
  siteName, # Required — Netlify site slug used for URL construction (e.g. "overeng-utils")
  siteId, # Required — stable Netlify site ID used for CLI targeting
  buildTaskPrefix ? "storybook:build",
}:
{ lib, pkgs, ... }:
let
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  deployTask = import ../lib/deploy-task.nix { inherit pkgs; };
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

        ${deployTask.mkRequiredEnvCheck {
          envName = "NETLIFY_AUTH_TOKEN";
          errorMessage = "Error: NETLIFY_AUTH_TOKEN is not set.";
          hint = "Set it via: export NETLIFY_AUTH_TOKEN=$(op read 'op://...')";
        }}

        deploy_dir="${pkg.path}/storybook-static"
        workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' "${pkg.path}/package.json")"

        if [ ! -d "$deploy_dir" ]; then
          echo "Skipping ${pkg.name}: no build output at $deploy_dir" >&2
          echo "Run 'dt ${buildTaskPrefix}:${pkg.name}' first." >&2
          exit 0
        fi

        ${deployTask.mkDeployTypeParser {
          defaultType = "draft";
          allowedTypes = [
            "prod"
            "pr"
            "draft"
          ];
          providerLabel = "Netlify";
        }}
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
          --site="${siteId}" \
          --auth="$NETLIFY_AUTH_TOKEN" \
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
          raw_deploy_url="https://$deploy_id--${siteName}.netlify.app"
        fi
        if [ -z "$raw_deploy_url" ]; then
          echo "Error: Could not determine unique Netlify deploy URL for ${pkg.name}" >&2
          cat "$deploy_log" >&2
          rm -f "$deploy_log"
          exit 1
        fi

        final_url="$logged_website_url"
        if [ -n "$alias_name" ]; then
          final_url="https://$alias_name--${siteName}.netlify.app"
        fi
        if [ -z "$final_url" ]; then
          final_url="$raw_deploy_url"
        fi

        ${deployTask.mkDeployMetadataEmitter {
          provider = "netlify";
          providerLabel = "Netlify";
          target = pkg.name;
          legacyMetadataPrefix = "NETLIFY_DEPLOY_METADATA";
        }}
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
