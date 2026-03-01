# Vercel deploy tasks for prebuilt directories
#
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.vercel {
#       deployments = [
#         {
#           name = "web";
#           path = "apps/web";
#           outputDir = "dist";
#           projectIdEnv = "VERCEL_PROJECT_ID_WEB";
#         }
#       ];
#       buildTaskPrefix = "build";
#     })
#   ];
#
# Deploy modes (via --input):
#   dt vercel:deploy:web                              # preview
#   dt vercel:deploy:web --input type=prod            # production
#   dt vercel:deploy:web --input type=pr --input pr=42
#
# Provides:
#   Tasks:
#     - vercel:deploy:<name> - Deploy specific prebuilt directory to Vercel
#     - vercel:deploy        - Aggregate: deploy all configured targets
{
  deployments ? [ ],
  buildTaskPrefix ? null,
}:
{ lib, pkgs, ... }:
let
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      orgIdEnv = deployment.orgIdEnv or "VERCEL_ORG_ID";
      projectIdEnv = deployment.projectIdEnv or "VERCEL_PROJECT_ID";
      outputDir = deployment.outputDir or "dist";
      buildDeps = if buildTaskPrefix == null then [ ] else [ "${buildTaskPrefix}:${deployment.name}" ];
    in
    {
      "vercel:deploy:${deployment.name}" = {
        description = "Deploy ${deployment.name} to Vercel";
        after = buildDeps;
        exec = ''
          set -euo pipefail

          if [ -z "''${VERCEL_TOKEN:-}" ]; then
            echo "Error: VERCEL_TOKEN is not set." >&2
            echo "Set it via: export VERCEL_TOKEN=\$(op read 'op://...')" >&2
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

          deploy_dir="${deployment.path}/${outputDir}"
          if [ ! -d "$deploy_dir" ]; then
            echo "Error: deploy directory not found: $deploy_dir" >&2
            echo "Run the build task first or configure outputDir correctly." >&2
            exit 1
          fi

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "preview"')"

          export VERCEL_ORG_ID="$org_id"
          export VERCEL_PROJECT_ID="$project_id"

          case "$deploy_type" in
            prod)
              echo "Deploying ${deployment.name} to production..."
              ${pkgs.bun}/bin/bunx vercel deploy "$deploy_dir" --yes --prod --token "$VERCEL_TOKEN"
              ;;
            pr|preview)
              pr_number="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.pr // empty')"
              if [ -n "$pr_number" ]; then
                echo "Deploying ${deployment.name} preview for PR #$pr_number..."
              else
                echo "Deploying ${deployment.name} preview..."
              fi
              ${pkgs.bun}/bin/bunx vercel deploy "$deploy_dir" --yes --token "$VERCEL_TOKEN"
              ;;
            *)
              echo "Error: Unknown deploy type '$deploy_type'. Use: prod, pr, preview" >&2
              exit 1
              ;;
          esac
        '';
      };
    };
in
{
  tasks = lib.mkMerge (
    (if hasDeployments then map mkDeployTask deployments else [ ])
    ++ [
      {
        "vercel:deploy" = {
          description = "Deploy all configured targets to Vercel";
          exec = null;
          after =
            if hasDeployments then map (deployment: "vercel:deploy:${deployment.name}") deployments else [ ];
        };
      }
    ]
  );
}
