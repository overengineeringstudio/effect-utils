# Vercel deploy tasks using local prebuilt artifacts
#
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.vercel {
#       deployments = [
#         {
#           name = "web";
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
#     - vercel:deploy:<name> - Prebuild + deploy specific target to Vercel
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
      cwd = deployment.cwd or ".";
      buildDeps = if buildTaskPrefix == null then [ ] else [ "${buildTaskPrefix}:${deployment.name}" ];
    in
    {
      "vercel:deploy:${deployment.name}" = {
        description = "Deploy ${deployment.name} to Vercel";
        after = buildDeps;
        exec = ''
          set -euo pipefail

          # Ensure native Node modules (e.g. sharp) can find libstdc++ on NixOS,
          # where prebuilt binaries lack proper RPATH for Nix store paths.
          export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

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

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "preview"')"

          export VERCEL_ORG_ID="$org_id"
          export VERCEL_PROJECT_ID="$project_id"

          case "$deploy_type" in
            prod)
              pull_env="production"
              build_flag="--prod"
              ;;
            pr|preview)
              pull_env="preview"
              build_flag=""
              ;;
            *)
              echo "Error: Unknown deploy type '$deploy_type'. Use: prod, pr, preview" >&2
              exit 1
              ;;
          esac

          # Run everything from the repo root so that rootDirectory (set in Vercel
          # dashboard) resolves correctly. The Vercel CLI joins rootDirectory with
          # cwd for both build and deploy — running from root avoids path doubling
          # (e.g. packages/app/packages/app) while keeping rootDirectory set, which
          # is required for serverless function trace file resolution in monorepos.
          #
          # Vercel dashboard must have rootDirectory set to "${cwd}" for each project.

          # Pull project settings and env vars to repo root.
          echo "Pulling Vercel project settings and env for ${deployment.name} ($pull_env)..."
          ${pkgs.bun}/bin/bunx vercel pull --yes --environment "$pull_env" --token "$VERCEL_TOKEN"

          # Override installCommand to no-op — dependencies are managed by devenv tasks.
          # Place vercel.json at the app dir (where the framework build runs).
          vercel_json="${cwd}/vercel.json"
          original_vercel_json=""
          cleanup_vercel_json() {
            if [ -n "$original_vercel_json" ]; then
              echo "$original_vercel_json" > "$vercel_json"
            elif [ -f "$vercel_json" ] && [ "''${_vercel_json_created:-}" = "1" ]; then
              rm -f "$vercel_json"
            fi
          }

          deploy_log=""
          cleanup() {
            cleanup_vercel_json
            # Clean up repo-root .vercel dir created by vercel pull (not tracked in git).
            rm -rf .vercel
            if [ -n "$deploy_log" ]; then
              rm -f "$deploy_log"
            fi
          }
          trap cleanup EXIT

          if [ -f "$vercel_json" ]; then
            original_vercel_json="$(cat "$vercel_json")"
            ${pkgs.jq}/bin/jq '. + {"installCommand": "true"}' "$vercel_json" > "$vercel_json.tmp" && mv "$vercel_json.tmp" "$vercel_json"
          else
            echo '{"installCommand":"true"}' > "$vercel_json"
            _vercel_json_created=1
          fi

          echo "Building ${deployment.name} locally with vercel build..."
          if [ -n "$build_flag" ]; then
            ${pkgs.bun}/bin/bunx vercel build --yes $build_flag --token "$VERCEL_TOKEN"
          else
            ${pkgs.bun}/bin/bunx vercel build --yes --token "$VERCEL_TOKEN"
          fi

          cleanup_vercel_json

          if [ ! -d ".vercel/output" ]; then
            echo "Error: Missing prebuilt output directory: .vercel/output" >&2
            exit 1
          fi

          deploy_log="$(mktemp)"
          case "$deploy_type" in
            prod)
              echo "Deploying ${deployment.name} prebuilt output to production..."
              ${pkgs.bun}/bin/bunx vercel deploy --prebuilt --yes --prod --token "$VERCEL_TOKEN" 2>&1 | tee "$deploy_log"
              deploy_exit=''${PIPESTATUS[0]}
              ;;
            pr|preview)
              pr_number="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.pr // empty')"
              if [ -n "$pr_number" ]; then
                echo "Deploying ${deployment.name} prebuilt preview for PR #$pr_number..."
              else
                echo "Deploying ${deployment.name} prebuilt preview..."
              fi
              ${pkgs.bun}/bin/bunx vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN" 2>&1 | tee "$deploy_log"
              deploy_exit=''${PIPESTATUS[0]}
              ;;
            *)
              echo "Error: Unknown deploy type '$deploy_type'. Use: prod, pr, preview" >&2
              exit 1
              ;;
          esac

          if [ "$deploy_exit" -ne 0 ]; then
            exit "$deploy_exit"
          fi

          deploy_url="$(${pkgs.gnugrep}/bin/grep -Eo 'https://[^[:space:]]+' "$deploy_log" | ${pkgs.gnugrep}/bin/grep -E 'vercel\.(app|com)' | tail -n 1 || true)"
          if [ -z "$deploy_url" ]; then
            echo "Error: Could not determine Vercel deploy URL from CLI output." >&2
            exit 1
          fi

          deploy_key_suffix="$(printf '%s' '${deployment.name}' | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
          if [ -n "''${DEVENV_TASK_OUTPUT_FILE:-}" ]; then
            ${pkgs.jq}/bin/jq -n \
              --arg genericKey "VERCEL_DEPLOY_URL" \
              --arg scopedKey "VERCEL_DEPLOY_URL_''${deploy_key_suffix}" \
              --arg deployUrl "$deploy_url" \
              '{devenv:{env:{($genericKey):$deployUrl,($scopedKey):$deployUrl}}}' > "$DEVENV_TASK_OUTPUT_FILE"
          fi

          echo "Vercel deploy URL: $deploy_url"
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
