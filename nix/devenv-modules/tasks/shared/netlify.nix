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

        echo "Deploying ${pkg.name} ($deploy_type)..."

        deploy_json_file="$(mktemp)"
        deploy_stderr_file="$(mktemp)"
        auth_user_file="$(mktemp)"
        auth_site_file="$(mktemp)"
        set +e
        # shellcheck disable=SC2086
        ${pkgs.bun}/bin/bunx netlify-cli@17.37.2 deploy \
          --dir="$deploy_dir" \
          --site="${siteId}" \
          --auth="$NETLIFY_AUTH_TOKEN" \
          --no-build \
          $alias_flag \
          --message="$message" \
          --json >"$deploy_json_file" 2>"$deploy_stderr_file"
        deploy_exit="$?"
        set -e

        if [ -s "$deploy_stderr_file" ]; then
          cat "$deploy_stderr_file" >&2
        fi
        if [ "$deploy_exit" -ne 0 ]; then
          if grep -q "Unauthorized: could not retrieve project" "$deploy_stderr_file"; then
            echo "Netlify auth diagnostics for ${pkg.name}:" >&2
            set +e
            ${pkgs.bun}/bin/bunx netlify-cli@17.37.2 api getCurrentUser --auth="$NETLIFY_AUTH_TOKEN" >"$auth_user_file" 2>/dev/null
            auth_user_exit="$?"
            ${pkgs.bun}/bin/bunx netlify-cli@17.37.2 api getSite --auth="$NETLIFY_AUTH_TOKEN" --data "{\"site_id\":\"${siteId}\"}" >"$auth_site_file" 2>/dev/null
            auth_site_exit="$?"
            set -e

            if [ "$auth_user_exit" -eq 0 ]; then
              user_email="$(${pkgs.jq}/bin/jq -r '.email // .full_name // .slug // "unknown"' "$auth_user_file")"
              user_slug="$(${pkgs.jq}/bin/jq -r '.slug // "unknown"' "$auth_user_file")"
              echo "  getCurrentUser: ok (''${user_email}, slug=''${user_slug})" >&2
            else
              echo "  getCurrentUser: failed" >&2
            fi

            if [ "$auth_site_exit" -eq 0 ]; then
              resolved_account_slug="$(${pkgs.jq}/bin/jq -r '.account_slug // "unknown"' "$auth_site_file")"
              resolved_site_name="$(${pkgs.jq}/bin/jq -r '.name // "unknown"' "$auth_site_file")"
              echo "  getSite(${siteId}): ok (site=''${resolved_site_name}, account=''${resolved_account_slug})" >&2
            else
              echo "  getSite(${siteId}): failed" >&2
            fi
          fi

          if [ -s "$deploy_json_file" ]; then
            cat "$deploy_json_file" >&2
          fi
          rm -f "$deploy_json_file" "$deploy_stderr_file" "$auth_user_file" "$auth_site_file"
          exit "$deploy_exit"
        fi

        if ! ${pkgs.jq}/bin/jq -e '.deploy_id and .site_name and .deploy_url' "$deploy_json_file" >/dev/null; then
          echo "Error: Netlify CLI did not return the expected deploy JSON for ${pkg.name}" >&2
          cat "$deploy_json_file" >&2
          rm -f "$deploy_json_file" "$deploy_stderr_file"
          exit 1
        fi

        deploy_id="$(${pkgs.jq}/bin/jq -r '.deploy_id' "$deploy_json_file")"
        resolved_site_name="$(${pkgs.jq}/bin/jq -r '.site_name' "$deploy_json_file")"
        deploy_url_from_json="$(${pkgs.jq}/bin/jq -r '.deploy_url' "$deploy_json_file")"

        if [ -z "$resolved_site_name" ] || [ "$resolved_site_name" = "null" ]; then
          resolved_site_name="${siteName}"
        fi

        raw_deploy_url="https://$deploy_id--$resolved_site_name.netlify.app"
        if [ -n "$alias_name" ]; then
          final_url="https://$alias_name--${siteName}.netlify.app"
        else
          final_url="$deploy_url_from_json"
        fi
        if [ -z "$final_url" ] || [ "$final_url" = "null" ]; then
          final_url="$raw_deploy_url"
        fi

        ${deployTask.mkDeployMetadataEmitter {
          provider = "netlify";
          providerLabel = "Netlify";
          target = pkg.name;
          legacyMetadataPrefix = "NETLIFY_DEPLOY_METADATA";
        }}
        rm -f "$deploy_json_file" "$deploy_stderr_file" "$auth_user_file" "$auth_site_file"
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
