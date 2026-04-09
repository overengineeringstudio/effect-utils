# Deploy pre-built static directories to Vercel using Build Output API v3
#
# Packages any static directory as a Vercel prebuilt deployment and optionally
# aliases it to a readable URL. Composable with any build task that produces
# a static directory (storybook, vite, next export, etc.).
#
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.vercel-static {
#       aliasSuffix = "my-team";  # → <prefix>-<suffix>.vercel.app
#       deployments = [
#         {
#           name = "storybook-tv";
#           dir = "packages/tv-museum-app/storybook-static";
#           projectIdEnv = "VERCEL_PROJECT_ID_TV";
#           aliasPrefix = "storybook-tv";       # optional, enables aliasing
#           afterTask = "storybook:build:tv";    # optional, task dependency
#         }
#       ];
#     })
#   ];
#
# Deploy modes (via --input):
#   dt vercel-static:deploy:storybook-tv                              # preview (no alias)
#   dt vercel-static:deploy:storybook-tv --input type=prod            # stable alias
#   dt vercel-static:deploy:storybook-tv --input type=pr --input pr=42
#
# Provides:
#   Tasks:
#     - vercel-static:deploy:<name> - Deploy specific static dir to Vercel
#     - vercel-static:deploy        - Aggregate: deploy all configured targets
{
  deployments ? [ ],
  aliasSuffix ? null,
}:
{ lib, pkgs, ... }:
let
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      orgIdEnv = deployment.orgIdEnv or "VERCEL_ORG_ID";
      projectIdEnv = deployment.projectIdEnv or "VERCEL_PROJECT_ID";
      dir = deployment.dir;
      aliasPrefix = deployment.aliasPrefix or null;
      afterTask = deployment.afterTask or null;
      afterDeps = if afterTask != null then [ afterTask ] else [ ];
    in
    {
      "vercel-static:deploy:${deployment.name}" = {
        description = "Deploy ${deployment.name} static files to Vercel";
        after = afterDeps;
        exec = ''
          set -euo pipefail

          if [ -z "''${VERCEL_TOKEN:-}" ]; then
            echo "Error: VERCEL_TOKEN is not set." >&2
            exit 1
          fi

          org_id="''${${orgIdEnv}:-}"
          if [ -z "$org_id" ]; then
            echo "Error: ${orgIdEnv} is not set." >&2
            exit 1
          fi

          project_id="''${${projectIdEnv}:-}"
          if [ -z "$project_id" ]; then
            echo "Error: ${projectIdEnv} is not set." >&2
            exit 1
          fi

          deploy_dir="${dir}"
          if [ ! -d "$deploy_dir" ]; then
            echo "Error: No build output at $deploy_dir" >&2
            echo "Run the build task first." >&2
            exit 1
          fi

          export VERCEL_ORG_ID="$org_id"
          export VERCEL_PROJECT_ID="$project_id"

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "preview"')"

          # Determine alias name based on deploy type
          alias_name=""
          ${lib.optionalString (aliasPrefix != null && aliasSuffix != null) ''
            case "$deploy_type" in
              prod)
                alias_name="${aliasPrefix}-${aliasSuffix}"
                ;;
              pr)
                pr_number="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.pr // empty')"
                if [ -z "$pr_number" ]; then
                  echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
                  exit 1
                fi
                alias_name="${aliasPrefix}-pr-''${pr_number}-${aliasSuffix}"
                ;;
              preview) ;;
              *)
                echo "Error: Unknown deploy type '$deploy_type'. Use: prod, pr, preview" >&2
                exit 1
                ;;
            esac
          ''}

          # Package as Vercel Build Output API v3
          work_dir="$(mktemp -d)"
          trap 'rm -rf "$work_dir"' EXIT

          mkdir -p "$work_dir/.vercel/output/static"
          echo '{"version": 3}' > "$work_dir/.vercel/output/config.json"
          cp -r "$deploy_dir/"* "$work_dir/.vercel/output/static/"

          echo "Deploying ${deployment.name} ($deploy_type) from $deploy_dir..."

          deploy_log="$(mktemp)"
          (cd "$work_dir" && ${pkgs.bun}/bin/bunx vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN" 2>&1) | tee "$deploy_log"
          deploy_exit=''${PIPESTATUS[0]}

          deploy_url="$(${pkgs.gnugrep}/bin/grep -Eo 'https://[^[:space:]"]+\.vercel\.app' "$deploy_log" | tail -n 1 || true)"
          rm -f "$deploy_log"

          if [ "$deploy_exit" -ne 0 ]; then
            exit "$deploy_exit"
          fi

          if [ -z "$deploy_url" ]; then
            echo "Error: Could not determine deploy URL from Vercel CLI output." >&2
            exit 1
          fi

          # Apply alias if configured
          final_url="$deploy_url"
          if [ -n "$alias_name" ]; then
            alias_url="''${alias_name}.vercel.app"
            ${pkgs.bun}/bin/bunx vercel alias "$deploy_url" "$alias_url" --token "$VERCEL_TOKEN"
            final_url="https://''${alias_url}"
          fi

          echo "Deploy URL: $final_url"

          # Export URL for CI and task output
          deploy_key_suffix="$(printf '%s' '${deployment.name}' | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
          if [ -n "''${DEVENV_TASK_OUTPUT_FILE:-}" ]; then
            ${pkgs.jq}/bin/jq -n \
              --arg genericKey "VERCEL_STATIC_DEPLOY_URL" \
              --arg scopedKey "VERCEL_STATIC_DEPLOY_URL_''${deploy_key_suffix}" \
              --arg deployUrl "$final_url" \
              '{devenv:{env:{($genericKey):$deployUrl,($scopedKey):$deployUrl}}}' > "$DEVENV_TASK_OUTPUT_FILE"
          fi
        '';
      };
    };
in
{
  tasks = lib.mkMerge (
    (if hasDeployments then map mkDeployTask deployments else [ ])
    ++ [
      {
        "vercel-static:deploy" = {
          description = "Deploy all static targets to Vercel";
          exec = null;
          after =
            if hasDeployments then
              map (deployment: "vercel-static:deploy:${deployment.name}") deployments
            else
              [ ];
        };
      }
    ]
  );
}
