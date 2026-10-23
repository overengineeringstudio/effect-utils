#!/usr/bin/env bash
set -euo pipefail

# Hooks export repository-local paths. A task's fixture repositories must resolve
# from their own cwd, never from the committing repository or its staged index.
# Ask Git for its complete list, including variables introduced by newer Git.
# A read loop (not mapfile) also works with the system Bash 3.2 on macOS.
git_local_env="$(git rev-parse --local-env-vars)"
while IFS= read -r variable; do
  unset "$variable"
done <<< "$git_local_env"

exec "$@"
