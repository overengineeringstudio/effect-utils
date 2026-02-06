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
  packages ? [],
  site,  # Required — Netlify site name (e.g. "overeng-utils")
  buildTaskPrefix ? "storybook:build",
}:
{ lib, pkgs, ... }:
let
  hasPackages = packages != [];

  mkDeployTask = pkg: {
    "netlify:deploy:${pkg.name}" = {
      description = "Deploy ${pkg.name} storybook to Netlify";
      exec = ''
        set -euo pipefail

        if [ -z "''${NETLIFY_AUTH_TOKEN:-}" ]; then
          echo "Error: NETLIFY_AUTH_TOKEN is not set." >&2
          echo "Set it via: export NETLIFY_AUTH_TOKEN=\$(op read 'op://...')" >&2
          exit 1
        fi

        deploy_dir="${pkg.path}/storybook-static"

        if [ ! -d "$deploy_dir" ]; then
          echo "Skipping ${pkg.name}: no build output at $deploy_dir" >&2
          echo "Run 'dt ${buildTaskPrefix}:${pkg.name}' first." >&2
          exit 0
        fi

        # Parse deploy context from DEVENV_TASK_INPUT (set by devenv --input flag)
        input="''${DEVENV_TASK_INPUT:-"{}"}"
        deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "draft"')"
        short_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

        alias_flag=""
        message="${pkg.name}"

        case "$deploy_type" in
          prod)
            alias_flag="--alias=${pkg.name}"
            message="${pkg.name} (prod, $short_sha)"
            ;;
          pr)
            pr_number="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.pr // empty')"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            alias_flag="--alias=${pkg.name}-pr-''${pr_number}"
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

        # shellcheck disable=SC2086
        bunx netlify-cli deploy \
          --dir="$deploy_dir" \
          --site="${site}" \
          --no-build \
          $alias_flag \
          --message="$message"
      '';
    };
  };

in {
  tasks = lib.mkMerge (
    (if hasPackages then map mkDeployTask packages else [])
    ++ [{
      "netlify:deploy" = {
        description = "Deploy all storybooks to Netlify";
        exec = null;
        after = if hasPackages
          then map (pkg: "netlify:deploy:${pkg.name}") packages
          else [];
      };
    }]
  );
}
