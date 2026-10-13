#!/usr/bin/env bash
# Drives buck2 against Namespace Bazel Remote Execution (REAPI v2).
# Token stays in a 0600 file and reaches buck2 only via the daemon env.
set -euo pipefail
# Fixture files carry a .fixture suffix so the effect-utils Buck project never
# parses them; the probe runs as its own Buck project in a scratch directory.
src=$(cd "$(dirname "$0")" && pwd)
proj=${NS_PROBE_DIR:-${TMPDIR:-/tmp}/ns-buck2-re-probe-project}
mkdir -p "$proj/prelude"
: >"$proj/.buckroot"
cp "$src/buckconfig.fixture" "$proj/.buckconfig"
cp "$src/BUCK.fixture" "$proj/BUCK"
cp "$src/prelude/BUCK.fixture" "$proj/prelude/BUCK"
cp "$src/defs.bzl" "$src/input.txt" "$proj/"
cp "$src/prelude/prelude.bzl" "$proj/prelude/"
cd "$proj"
BUCK2=${BUCK2:-buck2}
NSC=${NSC:-nsc}
KEY=${NS_KEY:-buck2-probe}
state=${XDG_RUNTIME_DIR:-/tmp}/ns-buck2-re-probe
mkdir -p -m 700 "$state"
if [ ! -s "$state/setup.json" ] || [ -n "${REFRESH:-}" ]; then
  (umask 077; "$NSC" bazel setup --static --key="$KEY" -o json >"$state/setup.json" 2>/dev/null)
fi
host() { jq -r ".$1" "$state/setup.json" | sed -E 's#^grpcs://##'; }
cat >.buckconfig.local <<EOF
[buck2_re_client]
  engine_address = $(host scheduler_endpoint)
  action_cache_address = $(host storage_endpoint)
  cas_address = $(host storage_endpoint)
EOF
NS_RE_TOKEN=$(jq -r .ingress_auth_token "$state/setup.json")
export NS_RE_TOKEN
exec "$BUCK2" "$@"
