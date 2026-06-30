{ ... }:
let
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
in
{
  inherit mkRequiredEnvCheck;
}
