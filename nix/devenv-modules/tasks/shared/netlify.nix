# Netlify deploy tasks for a single Netlify site.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy netlify`.
{
  deployments ? [ ],
  siteName,
  siteId ? null,
  ciToolsBin ? null,
}:
{ lib, pkgs, ... }:
let
  root = ../../../..;
  ciToolsPkg = import (root + "/packages/@overeng/ci-tools/nix/build.nix") {
    inherit pkgs;
    src = root;
    dirty = true;
  };
  resolvedCiToolsBin = if ciToolsBin == null then "${ciToolsPkg}/bin/ci-tools" else ciToolsBin;
  netlify = "${pkgs.netlify-cli}/bin/netlify";
  hasDeployments = deployments != [ ];

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      staticDir = deployment.staticDir;
      afterTask = deployment.afterTask or null;
      workspaceFilter = deployment.workspaceFilter or false;
      packageJsonPath = "${builtins.dirOf staticDir}/package.json";
    in
    {
      "netlify:deploy:${name}" = {
        description = "Deploy ${name} to Netlify";
        after = if afterTask == null then [ ] else [ afterTask ];
        exec = ''
          set -euo pipefail

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(${pkgs.jq}/bin/jq -r '.type // "draft"' <<<"$input")"
          case "$deploy_type" in
            prod|pr|draft) ;;
            *)
              echo "Error: Unknown Netlify deploy type '$deploy_type'. Use: prod, pr, draft" >&2
              exit 1
              ;;
          esac

          args=(
            deploy netlify
            --target ${lib.escapeShellArg name}
            --display-name ${lib.escapeShellArg name}
            --artifact-dir ${lib.escapeShellArg staticDir}
            --mode "$deploy_type"
            --site-name ${lib.escapeShellArg siteName}
            --site-id-env NETLIFY_SITE_ID
            --auth-token-env NETLIFY_AUTH_TOKEN
            --netlify-bin ${lib.escapeShellArg netlify}
          )

          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            args+=(--pr "$pr_number")
          fi

          ${if siteId != null then "export NETLIFY_SITE_ID=${lib.escapeShellArg siteId}" else ""}

          ${
            if workspaceFilter then
              ''
                workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' ${lib.escapeShellArg packageJsonPath})"
                if [ -n "$workspace_filter" ]; then
                  args+=(--workspace-filter "$workspace_filter")
                fi
              ''
            else
              ""
          }

          if [ -n "''${WORKFLOW_REPORT_OUTPUT_FILE:-}" ]; then
            args+=(--workflow-report-output-file "$WORKFLOW_REPORT_OUTPUT_FILE")
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
        "netlify:deploy" = {
          description = "Deploy all configured targets to Netlify";
          exec = null;
          after = if hasDeployments then map (d: "netlify:deploy:${d.name}") deployments else [ ];
        };
      }
    ]
  );
}
