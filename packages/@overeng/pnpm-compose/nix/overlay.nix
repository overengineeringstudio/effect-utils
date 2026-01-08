# pnpm guard overlay - wraps pnpm to prevent install in submodules
# This file can be imported directly in devenv.nix or other Nix configs
# Source of truth for the pnpm guard logic
final: prev: {
  pnpm = final.writeShellScriptBin "pnpm" ''
    # Check if we're trying to run install/i/add in a submodule
    if [[ "$1" == "install" || "$1" == "i" || "$1" == "add" ]]; then
      # Auto-detect repo root by walking up from cwd
      find_compose_root() {
        local dir="$PWD"
        while [[ "$dir" != "/" ]]; do
          # Look for pnpm-compose marker files
          if [[ -f "$dir/pnpm-compose.config.ts" ]] || [[ -f "$dir/pnpm-compose.config.js" ]]; then
            echo "$dir"
            return 0
          fi
          # Also check for .gitmodules (indicates potential composed repo)
          if [[ -f "$dir/.gitmodules" ]] && [[ -d "$dir/submodules" ]]; then
            echo "$dir"
            return 0
          fi
          dir="$(dirname "$dir")"
        done
        return 1
      }

      if root="$(find_compose_root)"; then
        current_dir="$(pwd)"
        if [[ "$current_dir" != "$root" ]] && [[ "$current_dir" == "$root/submodules/"* ]]; then
          echo "" >&2
          echo "┌─────────────────────────────────────────────────────────────┐" >&2
          echo "│  ERROR: Cannot run 'pnpm $1' inside a submodule             │" >&2
          echo "├─────────────────────────────────────────────────────────────┤" >&2
          echo "│  You're in a pnpm-compose managed repo.                     │" >&2
          echo "│  Running pnpm install here would corrupt the workspace.     │" >&2
          echo "│                                                             │" >&2
          echo "│  Instead, run from the parent repo:                         │" >&2
          echo "│    cd $root" >&2
          echo "│    pnpm-compose install                                     │" >&2
          echo "└─────────────────────────────────────────────────────────────┘" >&2
          echo "" >&2
          exit 1
        fi
      fi
    fi
    exec ${prev.pnpm_10}/bin/pnpm "$@"
  '';
}
