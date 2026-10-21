#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# An alternate boundary allows the same regression to demonstrate the unsafe
# pre-fix behavior using /usr/bin/env, entirely inside disposable repositories.
boundary="${1:-$root/scripts/without-git-local-env.sh}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL="$tmp/gitconfig" GIT_CONFIG_SYSTEM=/dev/null
printf '[user]\nname = Fixture\nemail = fixture@example.invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n' > "$GIT_CONFIG_GLOBAL"

for scenario in hook-index all-repository-paths; do
  sentinel="$tmp/$scenario/sentinel"
  fixture="$tmp/$scenario/fixture"
  mkdir -p "$sentinel" "$fixture"
  git -C "$sentinel" init -q
  printf 'committed sentinel\n' > "$sentinel/keep.txt"
  git -C "$sentinel" add keep.txt
  git -C "$sentinel" commit -qm sentinel
  printf 'staged sentinel change\n' > "$sentinel/keep.txt"
  git -C "$sentinel" add keep.txt
  head_before="$(git -C "$sentinel" rev-parse HEAD)"
  refs_before="$(git -C "$sentinel" show-ref)"
  cp "$sentinel/.git/index" "$tmp/index.before"
  cp "$sentinel/.git/config" "$tmp/config.before"
  printf 'fixture only\n' > "$fixture/fixture.txt"

  (
    cd "$fixture"
    export GIT_DIR="$sentinel/.git" GIT_INDEX_FILE="$sentinel/.git/index"
    if [[ $scenario == all-repository-paths ]]; then
      export GIT_WORK_TREE="$sentinel" GIT_PREFIX=hook-prefix/
      export GIT_COMMON_DIR="$sentinel/.git"
      export GIT_OBJECT_DIRECTORY="$sentinel/.git/objects"
      export GIT_ALTERNATE_OBJECT_DIRECTORIES="$sentinel/.git/objects"
    fi
    "$boundary" bash -euo pipefail -c '
      git init -q
      git add -A
      git commit -qm fixture
    '
  )

  [[ "$(git -C "$sentinel" rev-parse HEAD)" == "$head_before" ]] || {
    echo "FAIL: $scenario fixture changed sentinel HEAD" >&2
    exit 1
  }
  [[ "$(git -C "$sentinel" show-ref)" == "$refs_before" ]]
  cmp "$tmp/index.before" "$sentinel/.git/index"
  cmp "$tmp/config.before" "$sentinel/.git/config"
  [[ "$(cat "$sentinel/keep.txt")" == 'staged sentinel change' ]]
  [[ "$(git -C "$fixture" ls-tree --name-only HEAD)" == fixture.txt ]]
  printf 'PASS: %s fixture committed locally; sentinel HEAD, refs, index, config and worktree unchanged\n' "$scenario"
done

# The wrapper must preserve ordinary task behavior, not swallow failures.
code=0
"$boundary" bash -c 'exit 17' || code=$?
[[ $code == 17 ]]
echo 'PASS: child exit status preserved'

# If the variable list cannot be obtained, no task may run unsanitized.
mkdir "$tmp/bin"
printf '#!/usr/bin/env bash\nexit 61\n' > "$tmp/bin/git"
chmod +x "$tmp/bin/git"
code=0
PATH="$tmp/bin:$PATH" "$boundary" touch "$tmp/unsafe-child-started" || code=$?
[[ $code == 61 && ! -e "$tmp/unsafe-child-started" ]]
echo 'PASS: Git environment discovery failure prevents child execution'
