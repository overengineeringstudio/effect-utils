nix_cli_build_stamp() {
  local repo_path="$1"
  if [ -z "$repo_path" ]; then
    repo_path="$(pwd)"
  fi

  local rev ts stamp
  # Use git hash + local timestamp so dev builds are traceable without Nix eval.
  # Keep the format stable for caches and log greps: <rev>+<YYYY-MM-DD-HHMMSS>.
  rev=$(git -C "$repo_path" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  ts=$(date +%Y-%m-%d-%H%M%S)
  stamp="${rev}+${ts}"

  # Mark dirty to avoid confusing local builds with clean revisions.
  if [ "$rev" != "unknown" ] && [ -n "$(git -C "$repo_path" status --porcelain 2>/dev/null)" ]; then
    stamp="${stamp}-dirty"
  fi

  # Warn when CLI-related sources changed so developers know to rebuild binaries.
  nix_cli_warn_if_sources_changed "$repo_path"

  # Print without trailing newline so callers can embed directly.
  printf '%s' "$stamp"
}

nix_cli_warn_if_sources_changed() {
  local repo_path="$1"
  local entry path
  local changed=0

  if ! git -C "$repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  # Scan for edits that affect CLI build inputs (genie, pnpm-compose, shared deps).
  # Use porcelain -z to be robust against paths with spaces.
  while IFS= read -r -d '' entry; do
    path="${entry#?? }"
    # Keep this list narrow to avoid noisy warnings on unrelated edits.
    case "$path" in
      bun.lock|package.json|patches/*|nix/mk-bun-cli.nix|packages/@overeng/genie/*|packages/@overeng/pnpm-compose/*|packages/@overeng/utils/*)
        changed=1
        break
        ;;
    esac
  done < <(git -C "$repo_path" status --porcelain -z)

  if [ "$changed" -eq 1 ]; then
    printf '%s\n' "[devenv] WARNING: effect-utils CLI sources changed; run direnv reload to rebuild CLI binaries." >&2
  fi
}
