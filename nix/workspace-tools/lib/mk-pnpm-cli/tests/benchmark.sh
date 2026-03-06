#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

SYSTEM="${NIX_SYSTEM:-}"
BASELINE_REF="${BASELINE_REF:-}"
REPEATS=2
SCRATCH_DIR=""
KEEP=0
SKIP_GENIE=0
SKIP_MEGAREPO=0

usage() {
  cat <<'USAGE'
Usage: benchmark.sh [options]

Options:
  --baseline-ref <ref>  Git ref to benchmark against (defaults to merge-base HEAD origin/main)
  --repeats <n>         Number of rebuilds per ref/package (default: 2)
  --scratch-dir <path>  Scratch directory for the detached worktree and logs
  --keep                Keep the scratch directory after the run
  --skip-genie          Skip benchmarking the genie CLI
  --skip-megarepo       Skip benchmarking the megarepo CLI
  --system <system>     Nix system to build (defaults to builtins.currentSystem)
  --help                Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline-ref)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      BASELINE_REF="$2"
      shift 2
      ;;
    --repeats)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      REPEATS="$2"
      shift 2
      ;;
    --scratch-dir)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      SCRATCH_DIR="$2"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    --skip-genie)
      SKIP_GENIE=1
      shift
      ;;
    --skip-megarepo)
      SKIP_MEGAREPO=1
      shift
      ;;
    --system)
      if [ $# -lt 2 ]; then
        usage
        exit 1
      fi
      SYSTEM="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [ -z "$SYSTEM" ]; then
  SYSTEM="$(nix eval --impure --raw --expr builtins.currentSystem)"
fi

if [ -z "$BASELINE_REF" ]; then
  BASELINE_REF="$(cd "$ROOT" && git merge-base HEAD origin/main)"
fi

if ! [[ "$REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  echo "repeats must be a positive integer: $REPEATS" >&2
  exit 1
fi

if [ "$SKIP_GENIE" -eq 1 ] && [ "$SKIP_MEGAREPO" -eq 1 ]; then
  echo "nothing to benchmark" >&2
  exit 1
fi

if [ -z "$SCRATCH_DIR" ]; then
  mkdir -p "$ROOT/tmp"
  SCRATCH_DIR="$(mktemp -d "$ROOT/tmp/mk-pnpm-cli-benchmark.XXXXXX")"
else
  mkdir -p "$SCRATCH_DIR"
fi
SCRATCH_DIR="$(cd "$SCRATCH_DIR" && pwd -P)"

BASELINE_ROOT="$SCRATCH_DIR/baseline"
CURRENT_ROOT="$SCRATCH_DIR/current"
LOG_DIR="$SCRATCH_DIR/logs"
RESULTS_TSV="$SCRATCH_DIR/results.tsv"
mkdir -p "$LOG_DIR"
SENTINEL_RELATIVE_PATH="nix/workspace-tools/README.md"

cleanup() {
  if [ -d "$CURRENT_ROOT" ]; then
    git -C "$ROOT" worktree remove --force "$CURRENT_ROOT" >/dev/null 2>&1 || true
  fi

  if [ -d "$BASELINE_ROOT" ]; then
    git -C "$ROOT" worktree remove --force "$BASELINE_ROOT" >/dev/null 2>&1 || true
  fi

  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true

  if [ "$KEEP" -eq 0 ]; then
    rm -rf "$SCRATCH_DIR"
  fi
}
trap cleanup EXIT

if [ -e "$BASELINE_ROOT" ] || [ -e "$CURRENT_ROOT" ]; then
  echo "benchmark worktree already exists under: $SCRATCH_DIR" >&2
  exit 1
fi

CURRENT_REF="$(cd "$ROOT" && git rev-parse HEAD)"
git -C "$ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_REF" >/dev/null
git -C "$ROOT" worktree add --detach "$CURRENT_ROOT" "$CURRENT_REF" >/dev/null

CURRENT_REV="$(cd "$CURRENT_ROOT" && git rev-parse --short HEAD)"
BASELINE_REV="$(cd "$BASELINE_ROOT" && git rev-parse --short HEAD)"

printf 'run\tref\tattr\tseconds\n' > "$RESULTS_TSV"

now() {
  perl -MTime::HiRes=time -e 'printf "%.6f\n", time'
}

measure_build() {
  local ref_name="$1"
  local root="$2"
  local attr="$3"
  local run="$4"
  local log_file="$LOG_DIR/${ref_name}-${attr}-${run}.log"
  local sentinel_path="$root/$SENTINEL_RELATIVE_PATH"
  local backup_path="$SCRATCH_DIR/${ref_name}-${attr}-${run}.sentinel.bak"
  local start end elapsed

  if [ ! -f "$sentinel_path" ]; then
    echo "benchmark sentinel not found: $sentinel_path" >&2
    exit 1
  fi

  echo "Benchmark: $ref_name $attr run $run"
  cp "$sentinel_path" "$backup_path"
  printf '\n<!-- mk-pnpm-cli benchmark nonce: %s %s %s %s -->\n' \
    "$ref_name" \
    "$attr" \
    "$run" \
    "$(now)" >> "$sentinel_path"
  start="$(now)"
  if ! (
    cd "$root"
    nix build \
      --no-link \
      --no-write-lock-file \
      --option eval-cache false \
      "path:$root#packages.$SYSTEM.$attr"
  ) >"$log_file" 2>&1; then
    mv "$backup_path" "$sentinel_path"
    echo "benchmark failed for $ref_name $attr run $run" >&2
    tail -n 40 "$log_file" >&2
    exit 1
  fi
  end="$(now)"
  mv "$backup_path" "$sentinel_path"
  elapsed="$(awk -v start="$start" -v end="$end" 'BEGIN { printf "%.3f", end - start }')"
  printf '%s\t%s\t%s\t%s\n' "$run" "$ref_name" "$attr" "$elapsed" >> "$RESULTS_TSV"
}

benchmark_attr() {
  local attr="$1"
  local run
  for run in $(seq 1 "$REPEATS"); do
    measure_build "baseline" "$BASELINE_ROOT" "$attr" "$run"
    measure_build "current" "$CURRENT_ROOT" "$attr" "$run"
  done
}

if [ "$SKIP_GENIE" -eq 0 ]; then
  benchmark_attr "genie"
fi

if [ "$SKIP_MEGAREPO" -eq 0 ]; then
  benchmark_attr "megarepo"
fi

avg_seconds() {
  local ref_name="$1"
  local attr="$2"
  awk -F'\t' -v ref_name="$ref_name" -v attr="$attr" '
    NR > 1 && $2 == ref_name && $3 == attr {
      sum += $4
      count += 1
    }
    END {
      if (count == 0) {
        exit 1
      }
      printf "%.3f", sum / count
    }
  ' "$RESULTS_TSV"
}

print_summary_row() {
  local attr="$1"
  local baseline_avg current_avg delta_seconds delta_pct
  baseline_avg="$(avg_seconds baseline "$attr")"
  current_avg="$(avg_seconds current "$attr")"
  delta_seconds="$(awk -v baseline="$baseline_avg" -v current="$current_avg" 'BEGIN { printf "%+.3f", current - baseline }')"
  delta_pct="$(awk -v baseline="$baseline_avg" -v current="$current_avg" 'BEGIN { printf "%+.1f%%", ((current - baseline) / baseline) * 100 }')"

  printf '| %s | %s | %s | %s | %s |\n' \
    "$attr" \
    "$baseline_avg" \
    "$current_avg" \
    "$delta_seconds" \
    "$delta_pct"
}

echo
echo "mk-pnpm-cli benchmark"
echo "system: $SYSTEM"
echo "baseline ref: $BASELINE_REF ($BASELINE_REV)"
echo "current ref:  $CURRENT_REV"
echo "repeats: $REPEATS"
echo
echo '| attr | baseline avg (s) | current avg (s) | delta (s) | delta (%) |'
echo '| --- | ---: | ---: | ---: | ---: |'

if [ "$SKIP_GENIE" -eq 0 ]; then
  print_summary_row "genie"
fi

if [ "$SKIP_MEGAREPO" -eq 0 ]; then
  print_summary_row "megarepo"
fi

echo
echo "Raw results: $RESULTS_TSV"
echo "Logs: $LOG_DIR"
