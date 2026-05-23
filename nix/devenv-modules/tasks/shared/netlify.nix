# Netlify deploy tasks for a single Netlify site.
#
# Each entry in `deployments` describes one prebuilt static directory to ship
# to the site. Multiple entries land on the same site under per-name aliases
# (e.g. multi-storybook previews); a single entry covers the common "deploy
# one app's dist/" case.
#
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#
#   # Single-artifact site (e.g. an Astro app):
#   (inputs.effect-utils.devenvModules.tasks.netlify {
#     siteName = "livestore-v2";
#     deployments = [{
#       name = "livestore-website";
#       staticDir = "./dist";
#       afterTask = "site:build:livestore-website";
#     }];
#   })
#
#   # Multi-target preview site (e.g. one storybook per workspace package):
#   (inputs.effect-utils.devenvModules.tasks.netlify {
#     siteName = "overeng-utils";
#     siteId = "01234567-89ab-cdef-0123-456789abcdef";
#     deployments = map (pkg: {
#       name = pkg.name;
#       staticDir = "${pkg.path}/storybook-static";
#       afterTask = "storybook:build:${pkg.name}";
#       workspaceFilter = true;
#     }) packages;
#   })
#
# Deployment entry fields:
#   name             — required slug (lowercase, alphanumeric, hyphens); used
#                      as the deploy alias and task suffix.
#   staticDir        — required path to the prebuilt directory to upload.
#   afterTask        — optional devenv task to run before this deploy (e.g.
#                      a build task). Pass `null` if the directory is already
#                      produced out-of-band.
#   workspaceFilter  — optional bool (default `false`). When true, derives
#                      `--filter=<workspace-name>` from `<staticDir>/../package.json`
#                      for pnpm-workspace consumers. Most sites don't need this.
#
# Deploy modes (via --input):
#   dt netlify:deploy:<name>                          # draft (unique URL)
#   dt netlify:deploy:<name> --input type=prod        # prod alias
#   dt netlify:deploy:<name> --input type=pr --input pr=42  # PR preview alias
#
# Provides:
#   Tasks:
#     - netlify:deploy:<name> - Deploy a single entry to Netlify
#     - netlify:deploy        - Aggregate: deploy all `deployments`
{
  deployments ? [ ],
  siteName,
  siteId ? null,
}:
{ lib, pkgs, ... }:
let
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  deployTask = import ../lib/deploy-task.nix { inherit pkgs; };
  git = "${pkgs.git}/bin/git";
  netlify = "${pkgs.netlify-cli}/bin/netlify";
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      staticDir = deployment.staticDir;
      afterTask = deployment.afterTask or null;
      workspaceFilter = deployment.workspaceFilter or false;
      # `staticDir` is typically `<pkg>/dist` or `<pkg>/storybook-static`; the
      # workspace's package.json sits one level up.
      packageJsonPath = "${builtins.dirOf staticDir}/package.json";
    in
    {
      "netlify:deploy:${name}" = {
        description = "Deploy ${name} to Netlify";
        # `dt` runs `after` tasks in before-mode, so the build runs first.
        after = if afterTask == null then [ ] else [ afterTask ];
        exec = ''
          set -euo pipefail

          ${deployTask.mkRequiredEnvCheck {
            envName = "NETLIFY_AUTH_TOKEN";
            errorMessage = "Error: NETLIFY_AUTH_TOKEN is not set.";
            hint = "Run through: secrets-run --reason 'deploy Netlify preview' -- dt netlify:deploy:<target>";
          }}

          deploy_dir="${staticDir}"
          ${
            if workspaceFilter then
              ''workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' "${packageJsonPath}")"''
            else
              ''workspace_filter=""''
          }

          if [ ! -d "$deploy_dir" ]; then
            echo "Skipping ${name}: no build output at $deploy_dir" >&2
            ${
              if afterTask == null then
                ''echo "Build the directory first." >&2''
              else
                ''echo "Run 'dt ${afterTask}' first." >&2''
            }
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

          ${deployTask.mkAliasResolver {
            prefix = name;
            previewKeyword = "draft";
          }}

          if [ -n "$alias_name" ]; then
            alias_flag="--alias=$alias_name"
          else
            alias_flag=""
          fi

          case "$deploy_type" in
            prod)   message="${name} (prod, $short_sha)" ;;
            pr)     message="${name} (PR #''${pr_number}, $short_sha)" ;;
            draft)  message="${name} (draft, $short_sha)" ;;
          esac

          echo "Deploying ${name} ($deploy_type)..."

          deploy_json_file="$(mktemp)"
          deploy_stderr_file="$(mktemp)"
          auth_user_file="$(mktemp)"
          auth_site_file="$(mktemp)"
          set +e
          site_target_args=()
          if [ -n "${if siteId != null then siteId else ""}" ]; then
            export NETLIFY_SITE_ID="${if siteId != null then siteId else ""}"
          else
            site_target_args+=("--site=${siteName}")
          fi

          filter_args=()
          if [ -n "$workspace_filter" ]; then
            filter_args+=("--filter=$workspace_filter")
          fi

          # shellcheck disable=SC2086
          ${netlify} deploy \
            --dir="$deploy_dir" \
            --auth="$NETLIFY_AUTH_TOKEN" \
            "''${filter_args[@]}" \
            --no-build \
            "''${site_target_args[@]}" \
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
              echo "Netlify auth diagnostics for ${name}:" >&2
              set +e
              ${netlify} api getCurrentUser --auth="$NETLIFY_AUTH_TOKEN" >"$auth_user_file" 2>/dev/null
              auth_user_exit="$?"
              if [ -n "${if siteId != null then siteId else ""}" ]; then
                ${netlify} api getSite --auth="$NETLIFY_AUTH_TOKEN" --data "{\"site_id\":\"${
                  if siteId != null then siteId else ""
                }\"}" >"$auth_site_file" 2>/dev/null
                auth_site_exit="$?"
              else
                auth_site_exit=1
              fi
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
                echo "  getSite(${
                  if siteId != null then siteId else "site-id-unset"
                }): ok (site=''${resolved_site_name}, account=''${resolved_account_slug})" >&2
              else
                echo "  getSite: skipped or failed (no siteId configured)" >&2
              fi
            fi

            if [ -s "$deploy_json_file" ]; then
              cat "$deploy_json_file" >&2
            fi
            rm -f "$deploy_json_file" "$deploy_stderr_file" "$auth_user_file" "$auth_site_file"
            exit "$deploy_exit"
          fi

          if ! ${pkgs.jq}/bin/jq -e '.deploy_id and .site_name and .deploy_url' "$deploy_json_file" >/dev/null; then
            echo "Error: Netlify CLI did not return the expected deploy JSON for ${name}" >&2
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
            target = name;
            legacyMetadataPrefix = "NETLIFY_DEPLOY_METADATA";
          }}
          rm -f "$deploy_json_file" "$deploy_stderr_file" "$auth_user_file" "$auth_site_file"
        '';
      };
    };

in
{
  tasks = lib.mkMerge (
    (if hasDeployments then map (d: cliGuard.stripGuards (mkDeployTask d)) deployments else [ ])
    ++ [
      (cliGuard.stripGuards {
        "netlify:deploy" = {
          description = "Deploy all configured targets to Netlify";
          exec = null;
          after = if hasDeployments then map (d: "netlify:deploy:${d.name}") deployments else [ ];
        };
      })
    ]
  );
}
