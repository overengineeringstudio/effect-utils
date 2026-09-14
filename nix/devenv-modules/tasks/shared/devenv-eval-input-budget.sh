#!/usr/bin/env bash
set -euo pipefail

db=""
budget=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      db="${2:-}"
      shift 2
      ;;
    --budget)
      budget="${2:-}"
      shift 2
      ;;
    *)
      echo "devenv-eval-input-budget: unexpected argument '$1'" >&2
      exit 2
      ;;
  esac
done

if [ -z "$db" ] || [ -z "$budget" ]; then
  echo "usage: devenv-eval-input-budget --db <nix-eval-cache.db> --budget <max-files>" >&2
  exit 2
fi

if [ ! -f "$db" ]; then
  echo "no eval cache at $db, so nothing is registered yet."
  echo "devenv writes it on its first invocation in a worktree; this gate measures after one."
  exit 0
fi

probe='select fi.path, fi.recursive, fi.is_directory, eip.file_input_id, ce.attr_name
         from file_input fi
         join eval_input_path eip on eip.file_input_id = fi.id
         join cached_eval ce on ce.id = eip.cached_eval_id
        limit 1;'
if ! sqlite3 -readonly "$db" "$probe" >/dev/null 2>&1; then
  echo "$db does not answer the recursive-input query devenv's schema used to support."
  echo "devenv changed its eval-cache schema. Re-derive this query before trusting this gate again; skipping."
  exit 0
fi

rows=$(sqlite3 -readonly -tabs "$db" \
  'select distinct hex(ce.attr_name), hex(fi.path)
     from file_input fi
     join eval_input_path eip on eip.file_input_id = fi.id
     join cached_eval ce on ce.id = eip.cached_eval_id
    where fi.recursive = 1 and fi.is_directory = 1
    order by hex(ce.attr_name), hex(fi.path);')

if [ -z "$rows" ]; then
  echo "no recursive directory inputs registered: 0 of $budget files."
  exit 0
fi

attributes=$(printf '%s\n' "$rows" | cut -f1 | sort -u)
decode_hex() {
  local hex="$1"
  local escaped=""
  while [ -n "$hex" ]; do
    escaped="${escaped}\\x${hex:0:2}"
    hex="${hex:2}"
  done
  REPLY=$(printf '%b\001' "$escaped")
  REPLY="${REPLY%$'\001'}"
}

violations=""
while IFS= read -r attribute_hex; do
  [ -n "$attribute_hex" ] || continue
  decode_hex "$attribute_hex"
  attribute="$REPLY"
  total=0
  roots=0
  root_report=""
  while IFS=$'\t' read -r row_attribute_hex dir_hex; do
    [ "$row_attribute_hex" = "$attribute_hex" ] || continue
    decode_hex "$dir_hex"
    dir="$REPLY"
    if [ -d "$dir" ]; then
      count=$(find "$dir" -type f -printf . 2>/dev/null | wc -c)
    else
      count=0
    fi
    total=$((total + count))
    roots=$((roots + 1))
    root_report="${root_report}    ${count} files  ${dir}
"
  done <<ROWS
$rows
ROWS

  printf 'attribute %s: %s files across %s recursive inputs\n' "$attribute" "$total" "$roots"
  printf '%s' "$root_report"
  if [ "$total" -gt "$budget" ]; then
    violations="${violations}  ${attribute}: ${total} files
"
  fi
done <<ATTRIBUTES
$attributes
ATTRIBUTES

if [ -n "$violations" ]; then
  printf '\nrecursive eval-cache input budget exceeded; budget %s files per cached attribute:\n%b' \
    "$budget" "$violations" >&2
  cat >&2 <<'MSG'

devenv re-hashes every byte under each directory above whenever it validates
that cached attribute. Narrowing the fileset does not help; narrow the coercion
root so each cached attribute remains within budget.
MSG
  exit 1
fi

echo "within budget: every cached attribute has at most $budget recursive input files."
