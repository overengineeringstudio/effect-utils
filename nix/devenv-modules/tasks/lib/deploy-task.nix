{ pkgs, lib ? pkgs.lib }:
let
  # All deploy tasks accept the same high-level input shape via DEVENV_TASK_INPUT.
  # Provider modules still own their provider-specific behavior, but type parsing
  # should stay identical so CI can treat "pr", "production", etc. uniformly.
  mkDeployTypeParser =
    {
      defaultType,
      allowedTypes,
      providerLabel,
    }:
    ''
      input="''${DEVENV_TASK_INPUT:-"{}"}"
      deploy_type="$(echo "$input" | ${pkgs.jq}/bin/jq -r '.type // "${defaultType}"')"

      case "$deploy_type" in
        ${builtins.concatStringsSep "\n        " (map (type: "${type}) ;;") allowedTypes)}
        *)
          echo "Error: Unknown ${providerLabel} deploy type '$deploy_type'. Use: ${builtins.concatStringsSep ", " allowedTypes}" >&2
          exit 1
          ;;
      esac
    '';

  # Task wrappers may need to validate one env var, expose it under another
  # name, or both. We resolve through a shell variable name on purpose so the
  # generated script can support aliases like:
  #   read SCHICKLING_NETLIFY_TOKEN
  #   export NETLIFY_AUTH_TOKEN="$SCHICKLING_NETLIFY_TOKEN"
  # The indirect expansion is also the piece that was previously broken and
  # caused provider auth to disappear inside generated deploy wrappers.
  mkRequiredEnvCheck =
    {
      envName,
      errorMessage ? "Error: ${envName} is not set.",
      hint ? null,
      exportName ? envName,
      localName ? envName,
    }:
    ''
      local_name="${localName}"
      ${localName}="''${${envName}:-}"
      if [ -z "''${!local_name:-}" ]; then
        echo "${errorMessage}" >&2
        ${if hint == null then "" else ''echo "${hint}" >&2''}
        exit 1
      fi

      export ${exportName}="''${!local_name}"
    '';

  # Emit one strict metadata record that every deploy provider must satisfy.
  # CI consumes this contract instead of scraping provider-specific log lines.
  #
  # We intentionally write both:
  # - generic keys, so higher-level CI logic can stay provider-agnostic
  # - provider-scoped keys, so existing tasks and ad-hoc debugging stay usable
  #
  # `raw_deploy_url` is the unique deploy artifact URL.
  # `final_url` is the user-facing URL after aliasing, if any.
  mkDeployMetadataEmitter =
    {
      provider,
      providerLabel,
      target,
      displayName ? target,
      legacyMetadataPrefix ? null,
    }:
    let
      providerUpper = lib.toUpper provider;
    in
    ''
      deployed_at_utc="''${deployed_at_utc:-$(${pkgs.coreutils}/bin/date -u +%Y-%m-%dT%H:%M:%SZ)}"
      deploy_key_suffix="$(printf '%s' '${target}' | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"

      deploy_metadata_json="$(${pkgs.jq}/bin/jq -cn \
        --arg provider '${provider}' \
        --arg target '${target}' \
        --arg displayName '${displayName}' \
        --arg rawDeployUrl "$raw_deploy_url" \
        --arg finalUrl "$final_url" \
        --arg deployedAtUtc "$deployed_at_utc" \
        '{provider: $provider, target: $target, displayName: $displayName, rawDeployUrl: $rawDeployUrl, finalUrl: $finalUrl, deployedAtUtc: $deployedAtUtc}')"

      if [ -n "''${DEVENV_TASK_OUTPUT_FILE:-}" ]; then
        ${pkgs.jq}/bin/jq -n \
          --arg genericFinalKey "DEPLOY_FINAL_URL" \
          --arg genericFinalScopedKey "DEPLOY_FINAL_URL_''${deploy_key_suffix}" \
          --arg genericRawKey "DEPLOY_RAW_DEPLOY_URL" \
          --arg genericRawScopedKey "DEPLOY_RAW_DEPLOY_URL_''${deploy_key_suffix}" \
          --arg genericTimestampKey "DEPLOYED_AT_UTC" \
          --arg genericTimestampScopedKey "DEPLOYED_AT_UTC_''${deploy_key_suffix}" \
          --arg providerFinalKey "${providerUpper}_DEPLOY_URL" \
          --arg providerFinalScopedKey "${providerUpper}_DEPLOY_URL_''${deploy_key_suffix}" \
          --arg providerRawKey "${providerUpper}_RAW_DEPLOY_URL" \
          --arg providerRawScopedKey "${providerUpper}_RAW_DEPLOY_URL_''${deploy_key_suffix}" \
          --arg providerTimestampKey "${providerUpper}_DEPLOYED_AT_UTC" \
          --arg providerTimestampScopedKey "${providerUpper}_DEPLOYED_AT_UTC_''${deploy_key_suffix}" \
          --arg rawDeployUrl "$raw_deploy_url" \
          --arg finalDeployUrl "$final_url" \
          --arg deployedAtUtc "$deployed_at_utc" \
          '{
            devenv: {
              env: {
                ($genericFinalKey): $finalDeployUrl,
                ($genericFinalScopedKey): $finalDeployUrl,
                ($genericRawKey): $rawDeployUrl,
                ($genericRawScopedKey): $rawDeployUrl,
                ($genericTimestampKey): $deployedAtUtc,
                ($genericTimestampScopedKey): $deployedAtUtc,
                ($providerFinalKey): $finalDeployUrl,
                ($providerFinalScopedKey): $finalDeployUrl,
                ($providerRawKey): $rawDeployUrl,
                ($providerRawScopedKey): $rawDeployUrl,
                ($providerTimestampKey): $deployedAtUtc,
                ($providerTimestampScopedKey): $deployedAtUtc
              }
            }
          }' > "$DEVENV_TASK_OUTPUT_FILE"
      fi

      echo "${providerLabel} raw deploy URL: $raw_deploy_url"
      echo "${providerLabel} deploy URL: $final_url"
      echo "${providerLabel} deployed at UTC: $deployed_at_utc"
      echo "DEPLOY_TASK_METADATA: $deploy_metadata_json"
      ${if legacyMetadataPrefix == null then "" else ''echo "${legacyMetadataPrefix}: $deploy_metadata_json"''}
    '';
in
{
  inherit mkDeployTypeParser mkRequiredEnvCheck mkDeployMetadataEmitter;
}
