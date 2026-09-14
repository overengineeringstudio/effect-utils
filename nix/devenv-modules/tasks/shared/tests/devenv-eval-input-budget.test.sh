#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$TESTS_DIR/../devenv-eval-input-budget.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

task_root="$tmpdir/task
root"
mkdir -p "$tmpdir/shell/nested" "$task_root" "$tmpdir/orphan"
: > "$tmpdir/shell/a"
: > "$tmpdir/shell/b"
: > "$tmpdir/shell/nested/name
with-newline"
: > "$task_root/a"
for i in $(seq 1 20); do : > "$tmpdir/orphan/f$i"; done

sqlite3 "$tmpdir/cache.db" "
  create table file_input (
    id integer primary key,
    path blob not null unique,
    is_directory boolean not null,
    recursive boolean not null default 0
  );
  create table cached_eval (id integer primary key, attr_name text not null);
  create table eval_input_path (
    id integer primary key,
    cached_eval_id integer not null,
    file_input_id integer not null,
    unique(cached_eval_id, file_input_id)
  );
  insert into file_input (id, path, is_directory, recursive) values
    (1, '$tmpdir/shell', 1, 1),
    (2, '$task_root', 1, 1),
    (3, '$tmpdir/orphan', 1, 1);
  insert into cached_eval (id, attr_name) values
    (1, 'shell'),
    (2, 'devenv.config.task.config:build');
  insert into eval_input_path (cached_eval_id, file_input_id) values
    (1, 1),
    (2, 2);
"

if "$CHECKER" --db "$tmpdir/cache.db" --budget 2 > "$tmpdir/over.log" 2>&1; then
  echo "FAIL: synthetic over-budget shell attribute passed" >&2
  exit 1
fi
grep -q 'shell: 3 files' "$tmpdir/over.log" || {
  echo "FAIL: failure did not name the over-budget shell attribute and count" >&2
  cat "$tmpdir/over.log" >&2
  exit 1
}
if grep -q "$tmpdir/orphan" "$tmpdir/over.log"; then
  echo "FAIL: stale file_input row was counted without a cached attribute edge" >&2
  exit 1
fi

"$CHECKER" --db "$tmpdir/cache.db" --budget 3 > "$tmpdir/within.log"
grep -q 'attribute shell: 3 files' "$tmpdir/within.log"
grep -q 'attribute devenv.config.task.config:build: 1 files' "$tmpdir/within.log"
grep -q 'within budget' "$tmpdir/within.log"

"$CHECKER" --db "$tmpdir/absent.db" --budget 3 > "$tmpdir/absent.log"
grep -q 'no eval cache at' "$tmpdir/absent.log"

echo "Devenv recursive eval-input budget tests passed."
