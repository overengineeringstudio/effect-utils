# Vercel deploy tasks using local prebuilt artifacts
#
# Design policy:
#   - Do not rely on Vercel CI / remote builds for these tasks.
#   - Always build locally first, then upload prebuilt output with
#     `vercel deploy --prebuilt`.
#   - Vercel is used here as the deployment target / runtime host, not as the
#     build executor.
#
# Supports two modes:
#   - Build mode (default): local `vercel build` → deploy --prebuilt
#   - Static mode (staticDir set): package local static dir → deploy --prebuilt → alias
#
# Deploy context is passed via DEVENV_TASK_INPUT (devenv --input flag).
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.vercel {
#       deployments = [
#         # Build mode: pull settings, build locally, deploy prebuilt output
#         { name = "web"; cwd = "packages/web"; projectIdEnv = "VERCEL_PROJECT_ID_WEB"; }
#         # Static mode: deploy pre-built directory with optional alias
#         {
#           name = "storybook-web";
#           staticDir = "packages/web/storybook-static";
#           projectIdEnv = "VERCEL_PROJECT_ID_WEB";
#           aliasPrefix = "storybook-web";
#           afterTask = "storybook:build:web";
#         }
#       ];
#       aliasSuffix = "my-team";  # → <prefix>-<suffix>.vercel.app (static only)
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
#     - vercel:deploy:<name> - Deploy specific target to Vercel
#     - vercel:deploy        - Aggregate: deploy all configured targets
{
  deployments ? [ ],
  buildTaskPrefix ? null,
  aliasSuffix ? null,
}:
{ lib, pkgs, ... }:
let
  hasDeployments = deployments != [ ];

  # Shared env validation + input parsing (used by both modes)
  sharedPreamble =
    deployment:
    let
      orgIdEnv = deployment.orgIdEnv or "VERCEL_ORG_ID";
      projectIdEnv = deployment.projectIdEnv or "VERCEL_PROJECT_ID";
    in
    ''
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

      export VERCEL_ORG_ID="$org_id"
      export VERCEL_PROJECT_ID="$project_id"

      input="''${DEVENV_TASK_INPUT:-"{}"}"
      deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "preview"')"
    '';

  # Shared URL extraction + output (used by both modes)
  sharedEpilogue =
    deployment:
    ''
      deploy_url="$(${pkgs.gnugrep}/bin/grep -Eo 'https://[^[:space:]"]+\.vercel\.app' "$deploy_log" | tail -n 1 || true)"
      rm -f "$deploy_log"

      if [ "$deploy_exit" -ne 0 ]; then
        exit "$deploy_exit"
      fi

      if [ -z "$deploy_url" ]; then
        echo "Error: Could not determine Vercel deploy URL from CLI output." >&2
        exit 1
      fi

      final_url="$deploy_url"
    '';

  outputUrl =
    deployment:
    ''
      deploy_key_suffix="$(printf '%s' '${deployment.name}' | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
      if [ -n "''${DEVENV_TASK_OUTPUT_FILE:-}" ]; then
        ${pkgs.jq}/bin/jq -n \
          --arg genericKey "VERCEL_DEPLOY_URL" \
          --arg scopedKey "VERCEL_DEPLOY_URL_''${deploy_key_suffix}" \
          --arg deployUrl "$final_url" \
          '{devenv:{env:{($genericKey):$deployUrl,($scopedKey):$deployUrl}}}' > "$DEVENV_TASK_OUTPUT_FILE"
      fi

      echo "Vercel deploy URL: $final_url"
    '';

  # ── Build mode ──────────────────────────────────────────────────────────
  # Pull Vercel project settings, build locally, then deploy prebuilt output.
  # This intentionally avoids Vercel-hosted CI/build execution.

  mkBuildDeployTask =
    deployment:
    let
      cwd = deployment.cwd or ".";
      extraEnv = deployment.env or { };
      buildDeps = if buildTaskPrefix == null then [ ] else [ "${buildTaskPrefix}:${deployment.name}" ];
    in
    {
      "vercel:deploy:${deployment.name}" = {
        description = "Deploy ${deployment.name} to Vercel";
        after = buildDeps;
        exec = ''
          ${sharedPreamble deployment}

          # Ensure native Node modules (e.g. sharp) can find libstdc++ on NixOS
          export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

          ${lib.concatStringsSep "\n          " (
            lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}") extraEnv
          )}

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

          echo "Pulling Vercel project settings and env for ${deployment.name} ($pull_env)..."
          ${pkgs.bun}/bin/bunx vercel pull --yes --environment "$pull_env" --token "$VERCEL_TOKEN"

          if [ "${cwd}" != "." ] && [ -f ".vercel/project.json" ]; then
            ${pkgs.jq}/bin/jq --arg rd "${cwd}" '.settings.rootDirectory = $rd' .vercel/project.json > .vercel/project.json.tmp \
              && mv .vercel/project.json.tmp .vercel/project.json
          fi

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

          ${sharedEpilogue deployment}
          ${outputUrl deployment}
        '';
      };
    };

  # ── Static mode ─────────────────────────────────────────────────────────
  # Package a local pre-built static directory as Build Output API v3, then
  # deploy and alias it. This also avoids any Vercel-hosted build step.

  mkStaticDeployTask =
    deployment:
    let
      dir = deployment.staticDir;
      aliasPrefix = deployment.aliasPrefix or null;
      afterTask = deployment.afterTask or null;
      afterDeps = if afterTask != null then [ afterTask ] else [ ];
    in
    {
      "vercel:deploy:${deployment.name}" = {
        description = "Deploy ${deployment.name} static files to Vercel";
        after = afterDeps;
        exec = ''
          ${sharedPreamble deployment}

          deploy_dir="${dir}"
          if [ ! -d "$deploy_dir" ]; then
            echo "Error: No build output at $deploy_dir" >&2
            echo "Run the build task first." >&2
            exit 1
          fi

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
          cp -r "$deploy_dir"/. "$work_dir/.vercel/output/static/"

          echo "Deploying ${deployment.name} ($deploy_type) from $deploy_dir..."

          deploy_log="$(mktemp)"
          (cd "$work_dir" && ${pkgs.bun}/bin/bunx vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN" 2>&1) | tee "$deploy_log"
          deploy_exit=''${PIPESTATUS[0]}

          ${sharedEpilogue deployment}

          # Apply alias if configured
          if [ -n "$alias_name" ]; then
            alias_url="''${alias_name}.vercel.app"
            ${pkgs.bun}/bin/bunx vercel alias "$deploy_url" "$alias_url" --token "$VERCEL_TOKEN"
            final_url="https://''${alias_url}"
          fi

          ${outputUrl deployment}
        '';
      };
    };

  # Route to the correct task builder based on whether staticDir is set
  mkDeployTask =
    deployment:
    if deployment ? staticDir then mkStaticDeployTask deployment else mkBuildDeployTask deployment;
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
