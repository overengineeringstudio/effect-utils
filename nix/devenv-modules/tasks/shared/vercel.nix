# Vercel deploy tasks using local artifacts.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy vercel`.
{
  deployments ? [ ],
  buildTaskPrefix ? null,
  aliasSuffix ? null,
  ciToolsBin ? null,
  vercelBin ? null,
}:
{ lib, pkgs, ... }:
let
  deployTask = import ../lib/deploy-task.nix { inherit pkgs; };
  root = ../../../..;
  ciToolsPkg = import (root + "/packages/@overeng/ci-tools/nix/build.nix") {
    inherit pkgs;
    src = root;
    dirty = true;
  };
  resolvedCiToolsBin = if ciToolsBin == null then "${ciToolsPkg}/bin/ci-tools" else ciToolsBin;
  defaultVercelBin = pkgs.writeShellScript "ci-tools-vercel" ''
    exec ${pkgs.bun}/bin/bunx vercel "$@"
  '';
  resolvedVercelBin = if vercelBin == null then defaultVercelBin else vercelBin;
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      isStatic = deployment ? staticDir;
      cwd = deployment.cwd or ".";
      artifactDir = if isStatic then deployment.staticDir else ".vercel/output";
      artifactKind = if isStatic then "static" else "prebuilt-output";
      afterTask = deployment.afterTask or null;
      buildDeps =
        if isStatic then
          (if afterTask == null then [ ] else [ afterTask ])
        else if buildTaskPrefix == null then
          [ ]
        else
          [ "${buildTaskPrefix}:${name}" ];
      projectIdEnv = deployment.projectIdEnv or "VERCEL_PROJECT_ID";
      orgIdEnv = deployment.orgIdEnv or "VERCEL_ORG_ID";
      teamIdEnv = deployment.teamIdEnv or null;
      scopeEnv = deployment.scopeEnv or null;
      protectionBypassEnv = deployment.protectionBypassEnv or null;
      aliasPrefix = deployment.aliasPrefix or null;
      urlEnvKey =
        deployment.urlEnvKey or "VERCEL_DEPLOY_URL_${
          lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)
        }";
      extraEnv = deployment.env or { };
    in
    {
      "vercel:deploy:${name}" = {
        description = "Deploy ${name} to Vercel";
        after = buildDeps;
        exec = ''
          set -euo pipefail

          ${deployTask.mkRequiredEnvCheck {
            envName = orgIdEnv;
            exportName = "VERCEL_ORG_ID";
            localName = "org_id";
          }}
          ${deployTask.mkRequiredEnvCheck {
            envName = projectIdEnv;
            exportName = "VERCEL_PROJECT_ID";
            localName = "project_id";
          }}

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(${pkgs.jq}/bin/jq -r '.type // "preview"' <<<"$input")"
          url_env_key="$(${pkgs.jq}/bin/jq -r '.urlEnvKey // .url_env_key // ${builtins.toJSON urlEnvKey}' <<<"$input")"
          case "$deploy_type" in
            prod|pr|preview) ;;
            *)
              echo "Error: Unknown Vercel deploy type '$deploy_type'. Use: prod, pr, preview" >&2
              exit 1
              ;;
          esac

          ${
            if isStatic then
              ""
            else
              ''
                if [ -z "''${VERCEL_TOKEN:-}" ]; then
                  echo "Vercel token is unavailable; delegating missing-auth reporting to ci-tools." >&2
                else
                # Ensure native Node modules (e.g. sharp) can find libstdc++ on NixOS.
                export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

                ${lib.concatStringsSep "\n                " (
                  lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}") extraEnv
                )}

                scope_args=()
                ${lib.optionalString (scopeEnv != null) ''
                  if [ -n "''${${scopeEnv}:-}" ]; then
                    scope_args+=(--scope "''${${scopeEnv}}")
                  fi
                ''}

                case "$deploy_type" in
                  prod)
                    pull_env="production"
                    build_flag="--prod"
                    ;;
                  pr|preview)
                    pull_env="preview"
                    build_flag=""
                    ;;
                esac

                echo "Pulling Vercel project settings and env for ${name} ($pull_env)..."
                ${pkgs.bun}/bin/bunx vercel pull --yes --environment "$pull_env" "''${scope_args[@]}" --token "$VERCEL_TOKEN"

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

                cleanup() {
                  cleanup_vercel_json
                  rm -rf .vercel
                }
                trap cleanup EXIT

                if [ -f "$vercel_json" ]; then
                  original_vercel_json="$(cat "$vercel_json")"
                  ${pkgs.jq}/bin/jq '. + {"installCommand": "true"}' "$vercel_json" > "$vercel_json.tmp" && mv "$vercel_json.tmp" "$vercel_json"
                else
                  echo '{"installCommand":"true"}' > "$vercel_json"
                  _vercel_json_created=1
                fi

                echo "Building ${name} locally with vercel build..."
                if [ -n "$build_flag" ]; then
                  ${pkgs.bun}/bin/bunx vercel build --yes $build_flag "''${scope_args[@]}" --token "$VERCEL_TOKEN"
                else
                  ${pkgs.bun}/bin/bunx vercel build --yes "''${scope_args[@]}" --token "$VERCEL_TOKEN"
                fi

                cleanup_vercel_json

                if [ ! -d ".vercel/output" ]; then
                  echo "Error: Missing prebuilt output directory: .vercel/output" >&2
                  exit 1
                fi
                fi
              ''
          }

          args=(
            deploy vercel
            --target ${lib.escapeShellArg name}
            --display-name ${lib.escapeShellArg name}
            --artifact-dir ${lib.escapeShellArg artifactDir}
            --artifact-kind ${lib.escapeShellArg artifactKind}
            --mode "$deploy_type"
            --project-id-env ${lib.escapeShellArg projectIdEnv}
            --org-id-env ${lib.escapeShellArg orgIdEnv}
            --auth-token-env VERCEL_TOKEN
            --vercel-bin ${lib.escapeShellArg resolvedVercelBin}
          )

          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            args+=(--pr "$pr_number")
          fi

          ${lib.optionalString (aliasSuffix != null) ''
            args+=(--alias-suffix ${lib.escapeShellArg aliasSuffix})
          ''}
          ${lib.optionalString (aliasPrefix != null) ''
            args+=(--alias-prefix ${lib.escapeShellArg aliasPrefix})
          ''}
          ${lib.optionalString (teamIdEnv != null) ''
            args+=(--team-id-env ${lib.escapeShellArg teamIdEnv})
          ''}
          ${lib.optionalString (scopeEnv != null) ''
            args+=(--scope-env ${lib.escapeShellArg scopeEnv})
          ''}
          ${lib.optionalString (protectionBypassEnv != null) ''
            args+=(--protection-bypass-env ${lib.escapeShellArg protectionBypassEnv})
          ''}

          if [ -n "''${WORKFLOW_REPORT_OUTPUT_FILE:-}" ]; then
            args+=(--workflow-report-output-file "$WORKFLOW_REPORT_OUTPUT_FILE")
          fi
          if [ -n "''${GITHUB_OUTPUT:-}" ]; then
            args+=(--github-output-file "$GITHUB_OUTPUT")
          fi
          if [ -n "''${GITHUB_ENV:-}" ]; then
            args+=(--github-env-file "$GITHUB_ENV")
          fi
          if [ -n "$url_env_key" ]; then
            args+=(--url-env-key "$url_env_key")
          fi

          ${lib.escapeShellArg resolvedCiToolsBin} "''${args[@]}"
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
