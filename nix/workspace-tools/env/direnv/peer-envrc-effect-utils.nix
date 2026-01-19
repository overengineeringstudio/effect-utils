builtins.toFile "peer-envrc-effect-utils.sh" ''
  # Peer repo helper that assumes a dotdot workspace with effect-utils as a sibling.
  # Keeps the .envrc one-liner simple while still enabling dirty builds.

  if [ -z "''${WORKSPACE_ROOT:-}" ]; then
    export WORKSPACE_ROOT="$(pwd)"
  fi

  effect_utils_root="''${WORKSPACE_ROOT}/../effect-utils"
  NIX_CLI_FLAKE="$effect_utils_root"
  NIX_CLI_WORKSPACE_ROOT="$effect_utils_root"

  source "${import ./peer-envrc.nix}"

  unset effect_utils_root
  unset NIX_CLI_FLAKE
  unset NIX_CLI_WORKSPACE_ROOT
''
