builtins.toFile "effect-utils-envrc.sh" ''
  # Effect-utils direnv helper.
  # - Loads .envrc.local when present.
  # - Boots devenv via direnv.
  # - Delegates CLI rebuilds to the peer helper.

  export WORKSPACE_ROOT="$(pwd)"

  if test -f ./.envrc.local; then
    source_env ./.envrc.local
  fi

  if command -v nix-shell >/dev/null 2>&1; then
    eval "$(devenv direnvrc)"
    use devenv

    source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT#direnv.peerEnvrc")"
  fi
''
