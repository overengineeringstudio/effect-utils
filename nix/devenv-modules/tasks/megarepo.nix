# Megarepo workspace generation task.
#
# Runs `mr generate nix --deep` when megarepo inputs change, and skips otherwise.
{ lib, ... }:
{
  tasks."megarepo:generate" = {
    description = "Generate megarepo envrc + workspace mirror";
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if ! command -v mr >/dev/null 2>&1; then
        echo "[devenv] Missing mr CLI in PATH. Add effect-utils megarepo package to devenv packages." >&2
        exit 1
      fi

      mr generate nix --deep
      exit 0
    '';
    status = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -f ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if [ ./megarepo.json -nt ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if [ -f ./megarepo.lock ] && [ ./megarepo.lock -nt ./.envrc.generated.megarepo ]; then
        exit 1
      fi

      if ! command -v mr >/dev/null 2>&1; then
        exit 1
      fi

      exit 0
    '';
  };
  tasks."megarepo:check" = {
    description = "Verify megarepo envrc + workspace mirror are present and consistent";
    exec = ''
      if [ ! -f ./megarepo.json ]; then
        exit 0
      fi

      if [ ! -f ./.envrc.generated.megarepo ]; then
        echo "[devenv] Missing .envrc.generated.megarepo. Run: devenv tasks run megarepo:generate" >&2
        exit 1
      fi

      if [ ! -f ./.direnv/megarepo-nix/workspace/flake.nix ]; then
        echo "[devenv] Missing .direnv/megarepo-nix/workspace/flake.nix. Run: devenv tasks run megarepo:generate" >&2
        exit 1
      fi

      nearest=$(sed -nE 's/^export MEGAREPO_ROOT_NEAREST="(.*)"$/\1/p' ./.envrc.generated.megarepo)
      if [ -z "$nearest" ]; then
        echo "[devenv] MEGAREPO_ROOT_NEAREST missing in .envrc.generated.megarepo" >&2
        exit 1
      fi

      repo_root="$(pwd -P)/"
      if [ "$nearest" != "$repo_root" ]; then
        echo "[devenv] MEGAREPO_ROOT_NEAREST mismatch." >&2
        echo "[devenv] Expected: $repo_root" >&2
        echo "[devenv] Found:    $nearest" >&2
        exit 1
      fi
    '';
  };
}
