# Netlify deploy tasks for a single Netlify site.
#
# The stable devenv task names remain here, but deploy semantics live in
# `ci-tools deploy netlify`.
#
# `ciToolsBin` is required and must be an absolute path to the wrapped
# `ci-tools` Buck product; there is no source build and no ambient PATH
# fallback, so a consumer supplies it explicitly:
#
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.netlify {
#       siteName = "example";
#       ciToolsBin = "${inputs.effect-utils.packages.${pkgs.system}.ci-tools}/bin/ci-tools";
#     })
#   ];
{
  deployments ? [ ],
  siteName,
  siteId ? null,
  ciToolsBin,
  netlifyCliPkg ? null,
  netlifyBin ? null,
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  root = ../../../..;
  resolvedCiToolsBin = ciToolsBin;
  defaultNetlifyCliPkg =
    if netlifyCliPkg == null then
      import (root + "/nix/provider-clis/netlify-cli") { inherit pkgs; }
    else
      netlifyCliPkg;
  resolvedNetlifyBin =
    if netlifyBin == null then "${defaultNetlifyCliPkg}/bin/netlify" else netlifyBin;
  hasDeployments = deployments != [ ];
  stagedTargetsScript = pkgs.writeText "netlify-staged-targets.sh" (
    builtins.readFile ./netlify-staged-targets.sh
  );

  urlEnvKeyFor =
    name:
    "NETLIFY_DEPLOY_URL_${lib.toUpper (builtins.replaceStrings [ "-" "." "/" ] [ "_" "_" "_" ] name)}";

  # `stageDir` is an absolute directory outside the source tree that holds
  # one `<target>/` subdirectory per deploy target. The build side writes it;
  # the credentialed side only reads it, so it never runs the build.
  readStageDir = taskName: ''
    stage_dir="$(${pkgs.jq}/bin/jq -r '.stageDir // .stage_dir // empty' <<<"''${DEVENV_TASK_INPUT:-"{}"}")"
    if [ -z "$stage_dir" ]; then
      echo "Error: ${taskName} requires 'stageDir' input (e.g. --input stageDir=/tmp/netlify-stage)" >&2
      exit 1
    fi
    case "$stage_dir" in
      /*) ;;
      *)
        echo "Error: ${taskName} requires an absolute 'stageDir', got '$stage_dir'" >&2
        exit 1
        ;;
    esac
  '';

  # Parses the deploy inputs shared by every target of one task run and
  # defines `deploy_netlify_target <target> <artifact dir> <default url env
  # key> [workspace filter]`.
  deployPrelude = ''
    input="''${DEVENV_TASK_INPUT:-"{}"}"
    deploy_type="$(${pkgs.jq}/bin/jq -r '.type // "draft"' <<<"$input")"
    missing_auth_policy="$(${pkgs.jq}/bin/jq -r '.missingAuthPolicy // .missing_auth_policy // "fail"' <<<"$input")"
    unauthorized_policy="$(${pkgs.jq}/bin/jq -r '.unauthorizedPolicy // .unauthorized_policy // "fail"' <<<"$input")"
    url_env_key_input="$(${pkgs.jq}/bin/jq -r '.urlEnvKey // .url_env_key // empty' <<<"$input")"
    case "$deploy_type" in
      prod|pr|draft) ;;
      *)
        echo "Error: Unknown Netlify deploy type '$deploy_type'. Use: prod, pr, draft" >&2
        exit 1
        ;;
    esac
    case "$missing_auth_policy" in
      fail|skip) ;;
      *)
        echo "Error: Unknown Netlify missing auth policy '$missing_auth_policy'. Use: fail, skip" >&2
        exit 1
        ;;
    esac
    case "$unauthorized_policy" in
      fail|skip) ;;
      *)
        echo "Error: Unknown Netlify unauthorized policy '$unauthorized_policy'. Use: fail, skip" >&2
        exit 1
        ;;
    esac

    pr_number=""
    if [ "$deploy_type" = "pr" ]; then
      pr_number="$(${pkgs.jq}/bin/jq -r '.pr // empty' <<<"$input")"
      if [ -z "$pr_number" ]; then
        echo "Error: PR deploy requires 'pr' input (e.g. --input pr=123)" >&2
        exit 1
      fi
    fi

    ${if siteId != null then "export NETLIFY_SITE_ID=${lib.escapeShellArg siteId}" else ""}

    deploy_netlify_target() {
      local target="$1"
      local artifact_dir="$2"
      local url_env_key="''${url_env_key_input:-$3}"
      local workspace_filter="''${4:-}"
      local -a args=(
        deploy netlify
        --target "$target"
        --display-name "$target"
        --artifact-dir "$artifact_dir"
        --mode "$deploy_type"
        --site-name ${lib.escapeShellArg siteName}
        --site-id-env NETLIFY_SITE_ID
        --auth-token-env NETLIFY_AUTH_TOKEN
        --netlify-bin ${lib.escapeShellArg resolvedNetlifyBin}
        --missing-auth-policy "$missing_auth_policy"
        --unauthorized-policy "$unauthorized_policy"
      )
      if [ -n "$pr_number" ]; then
        args+=(--pr "$pr_number")
      fi
      if [ -n "$workspace_filter" ]; then
        args+=(--workspace-filter "$workspace_filter")
      fi
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
    }
  '';

  mkDeployTask =
    deployment:
    let
      name = deployment.name;
      staticDir = deployment.staticDir;
      afterTask = deployment.afterTask or null;
      workspaceFilter = deployment.workspaceFilter or false;
      packageJsonPath = "${builtins.dirOf staticDir}/package.json";
      urlEnvKey = deployment.urlEnvKey or (urlEnvKeyFor name);
      after = if afterTask == null then [ ] else [ afterTask ];
    in
    {
      "netlify:deploy:${name}" = {
        description = "Deploy ${name} to Netlify";
        inherit after;
        exec = trace.exec "netlify:deploy:${name}" ''
          set -euo pipefail
          ${deployPrelude}
          workspace_filter=""
          ${lib.optionalString workspaceFilter ''
            workspace_filter="$(${pkgs.jq}/bin/jq -r '.name // empty' ${lib.escapeShellArg packageJsonPath})"
          ''}
          deploy_netlify_target ${lib.escapeShellArg name} ${lib.escapeShellArg staticDir} ${lib.escapeShellArg urlEnvKey} "$workspace_filter"
        '';
      };
      "netlify:stage:${name}" = {
        description = "Build ${name} and stage its static output for a separate Netlify deploy";
        inherit after;
        exec = trace.exec "netlify:stage:${name}" ''
          set -euo pipefail
          ${readStageDir "netlify:stage:${name}"}
          if [ ! -d ${lib.escapeShellArg staticDir} ]; then
            echo "Error: ${name} static output ${staticDir} does not exist after its build" >&2
            exit 1
          fi
          target_dir="$stage_dir/"${lib.escapeShellArg name}
          rm -rf "$target_dir"
          mkdir -p "$target_dir"
          cp -RL ${lib.escapeShellArg staticDir}/. "$target_dir/"
        '';
      };
    };

in
{
  # The generated deploy workflow always collects and publishes the records
  # emitted by this task. Keep that dependency inside the reusable module so a
  # consumer cannot compose a deploy job with missing report tasks.
  imports = [ ./workflow-report-module.nix ];

  effectUtils.workflowReport.ciToolsBin = ciToolsBin;

  tasks = lib.mkMerge (
    (if hasDeployments then map mkDeployTask deployments else [ ])
    ++ [
      {
        "netlify:deploy" = {
          description = "Deploy all configured targets to Netlify";
          exec = null;
          after = if hasDeployments then map (d: "netlify:deploy:${d.name}") deployments else [ ];
        };
        # Split build/deploy: an uncredentialed job runs `netlify:stage` and
        # uploads `stageDir`; a credentialed job restores it and runs
        # `netlify:deploy-staged`, which never builds.
        "netlify:stage" = {
          description = "Build all configured targets and stage their static output";
          exec = null;
          after = if hasDeployments then map (d: "netlify:stage:${d.name}") deployments else [ ];
        };
        # The credentialed side evaluates only its own (default-branch)
        # revision, so it cannot know which targets the build side's revision
        # configured. It deploys the staged directory names as data instead:
        # `netlify-staged-targets.sh` admits only real directories with
        # alias-safe names, and each deploy runs from an empty scratch cwd so
        # the Netlify CLI never reads project config (monorepo workspaces,
        # `netlify.toml`, `netlify/functions`) from the repo or the artifact.
        "netlify:deploy-staged" = {
          description = "Deploy every staged target to Netlify without building it";
          exec = trace.exec "netlify:deploy-staged" ''
            set -euo pipefail
            ${readStageDir "netlify:deploy-staged"}
            targets="$(${pkgs.bash}/bin/bash ${stagedTargetsScript} "$stage_dir")"
            ${deployPrelude}
            deploy_cwd="$(${pkgs.coreutils}/bin/mktemp -d)"
            trap '${pkgs.coreutils}/bin/rm -rf "$deploy_cwd"' EXIT
            cd "$deploy_cwd"
            failed=()
            while IFS= read -r target; do
              url_key="''${target^^}"
              if ! deploy_netlify_target "$target" "$stage_dir/$target" "NETLIFY_DEPLOY_URL_''${url_key//-/_}"; then
                failed+=("$target")
              fi
            done <<<"$targets"
            if [ "''${#failed[@]}" -gt 0 ]; then
              echo "Error: Netlify deploy failed for staged targets: ''${failed[*]}" >&2
              exit 1
            fi
          '';
        };
      }
    ]
  );
}
