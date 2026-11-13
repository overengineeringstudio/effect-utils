#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
export BUCK2_RULES_REPO="$repo_root"
# An existing realized root may be supplied by the broader packaging contract.
root="${2:-}"
if [[ -z "$root" ]]; then
  root="$(nix build --impure --no-link --print-out-paths --expr '
    let
      repo = builtins.toPath (builtins.getEnv "BUCK2_RULES_REPO");
      flake = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
      system = builtins.currentSystem;
      pkgs = import flake.inputs.nixpkgs { inherit system; };
    in flake.lib.mkConsumerBuckRoot {
      inherit pkgs;
      rules = flake.packages.${system}.buck2-rules;
      capabilities = flake.packages.${system}.buck2-capabilities;
      cellName = "fixture";
      watcherPolicy = "immutable-input";
    }
  ')"
fi

mkdir -p "$repo_root/tmp/declared-inputs-freshness"
work="$(mktemp -d "$repo_root/tmp/declared-inputs-freshness/packaged-XXXXXX")"
cleanup() {
  (cd "$work" && buck2 --isolation-dir packaged-freshness-consumer kill >/dev/null 2>&1) || true
  chmod -R u+w "$work"
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/.buck2" "$work/buck2/toolchains" "$work/freshness"
cp "$root/.buckroot" "$root/.buckconfig" "$root/.watchmanconfig" "$root/BUCK" "$work/"
cp "$root/buck2/toolchains/BUCK" "$work/buck2/toolchains/BUCK"
# Keep the actual packaged cells immutable. No shared implementation source is
# copied from the checkout: only the consumer's example inputs live here.
ln -s "$root/.buck2/rules" "$work/.buck2/rules"
ln -s "$root/.buck2/capabilities" "$work/.buck2/capabilities"
chmod u+w "$work/.buckconfig" "$work/BUCK" "$work/buck2/toolchains/BUCK"
fixture="$repo_root/buck2/tests/declared_inputs_freshness"
for input in consumer-generator.ts.fixture expected.BUCK megarepo.json package.json pnpm-lock.yaml pnpm-lock.sha256.json pnpm-workspace.yaml; do
  cp "$fixture/$input" "$work/freshness/$input"
done
python3 - "$fixture/BUCK" "$work/freshness/BUCK" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text()
source = source.replace('load("//buck2:', 'load("@rules//buck2:')
source = source.replace('"//buck2/dependencies:', '"@rules//buck2/dependencies:')
source = source.replace('"//:genie/', '"@rules//:genie/')
source = source.replace(
    '"//packages/@overeng/genie:src/',
    '"@rules//:packages/@overeng/genie/src/',
)
pathlib.Path(sys.argv[2]).write_text(source)
PY
(
  cd "$work"
  buck2 --isolation-dir packaged-freshness-consumer build \
    --target-platforms rules//buck2/platforms:host_platform \
    //freshness:fresh --show-full-json-output > result.json
  python3 - "$work" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
outputs = json.loads((root / 'result.json').read_text())
assert len(outputs) == 1, outputs
output = pathlib.Path(next(iter(outputs.values())))
if not output.is_absolute():
    output = root / output
report = json.loads((output / 'freshness.json').read_text())
assert report['verdict'] == 'fresh', report
assert len(report['files']) == 2, report
assert all(file['verdict'] == 'fresh' for file in report['files']), report
assert (output / 'freshness.ok').read_text() == 'fresh\n'
PY
)
echo 'packaged declared-inputs freshness consumer passed'
