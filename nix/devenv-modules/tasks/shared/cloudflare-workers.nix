# Cloudflare Workers deploy tasks. Consumers own the Wrangler config and build;
# deployment semantics live in the wrapped `ci-tools deploy cloudflare-workers`.
#
#   (inputs.effect-utils.devenvModules.tasks.cloudflare-workers {
#     ciToolsBin = "${inputs.effect-utils.packages.${pkgs.system}.ci-tools}/bin/ci-tools";
#     deployments = [ {
#       name = "example";
#       workerName = "example-worker";
#       config = "wrangler.jsonc"; # Relative to cwd (or an absolute path).
#       cwd = "apps/example"; # Relative to the devenv task working directory.
#       productionDomains = [ "example.com" ];
#       afterTask = "example:build";
#     } ];
#   })
#
# Run with `devenv tasks run cloudflare-workers:deploy --input type=prod`, or
# `--input type=pr --input pr=123`. The same inherited environment reaches build
# dependencies and Wrangler; this module does not resolve or filter secrets.
# For local parity, import the shared secretspec module and use:
#   secrets-run --reason "deploy Workers" -- devenv tasks run cloudflare-workers:deploy --input type=pr --input pr=123
# Keep secret values in the consumer's secretspec.toml, never in these arguments
# or a deployment's optional non-secret `env` overrides (which apply at deploy).
{
  deployments ? [ ],
  ciToolsBin,
  wranglerPkg ? null,
  wranglerBin ? null,
  authTokenEnv ? "CLOUDFLARE_API_TOKEN",
  accountIdEnv ? "CLOUDFLARE_ACCOUNT_ID",
  cloudflareApiBaseUrl ? "https://api.cloudflare.com/client/v4",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  root = ../../../..;
  defaultWranglerPkg =
    if wranglerPkg == null then
      import (root + "/nix/provider-clis/wrangler") { inherit pkgs; }
    else
      wranglerPkg;
  resolvedWranglerBin = if wranglerBin == null then "${defaultWranglerPkg}/bin/wrangler" else wranglerBin;

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      workerName = deployment.workerName;
      config = deployment.config;
      cwd = deployment.cwd or ".";
      productionDomains = deployment.productionDomains or [ ];
      afterTask = deployment.afterTask or null;
      extraEnv = deployment.env or { };
      urlEnvKey =
        deployment.urlEnvKey or "CLOUDFLARE_WORKERS_DEPLOY_URL_${
          lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)
        }";
    in
    {
      "cloudflare-workers:deploy:${name}" = {
        description = "Deploy ${name} to Cloudflare Workers";
        after = if afterTask == null then [ ] else [ afterTask ];
        exec = trace.exec "cloudflare-workers:deploy:${name}" ''
          set -euo pipefail

          input="''${DEVENV_TASK_INPUT:-"{}"}"
          deploy_type="$(${pkgs.jq}/bin/jq -r '.type // empty' <<<"$input")"
          url_env_key="$(${pkgs.jq}/bin/jq -r '.urlEnvKey // .url_env_key // ${builtins.toJSON urlEnvKey}' <<<"$input")"
          case "$deploy_type" in
            prod|pr) ;;
            *)
              echo "Error: Cloudflare Workers deploy requires 'type' input: prod or pr" >&2
              exit 1
              ;;
          esac

          args=(
            deploy cloudflare-workers
            --target ${lib.escapeShellArg name}
            --worker-name ${lib.escapeShellArg workerName}
            --config ${lib.escapeShellArg config}
            --cwd ${lib.escapeShellArg cwd}
            --mode "$deploy_type"
            --auth-token-env ${lib.escapeShellArg authTokenEnv}
            --account-id-env ${lib.escapeShellArg accountIdEnv}
            --cloudflare-api-base-url ${lib.escapeShellArg cloudflareApiBaseUrl}
            --wrangler-bin ${lib.escapeShellArg resolvedWranglerBin}
          )
          if [ "$deploy_type" = "pr" ]; then
            pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
            if [ -z "$pr_number" ]; then
              echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
              exit 1
            fi
            args+=(--pr "$pr_number")
          fi
          ${lib.concatStringsSep "\n          " (
            map (domain: "args+=(--production-domain ${lib.escapeShellArg domain})") productionDomains
          )}
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
          ${lib.concatStringsSep "\n          " (
            lib.mapAttrsToList (key: value: "export ${lib.escapeShellArg "${key}=${value}"}") extraEnv
          )}
          ${lib.escapeShellArg ciToolsBin} "''${args[@]}"
        '';
      };
    };
in
{
  imports = [ ./workflow-report-module.nix ];

  effectUtils.workflowReport.ciToolsBin = ciToolsBin;

  tasks = lib.mkMerge (
    map mkDeployTask deployments
    ++ [
      {
        "cloudflare-workers:deploy" = {
          description = "Deploy all configured targets to Cloudflare Workers";
          exec = null;
          after = map (deployment: "cloudflare-workers:deploy:${deployment.name}") deployments;
        };
      }
    ]
  );
}
