#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(git rev-parse --show-toplevel)}"
export BUCK2_PRODUCTS_REPO="$repo_root"
fixture="$(mktemp -d)"
buck2=""
trap 'if [[ -n "$buck2" ]]; then (cd "$fixture/root" && "$buck2" --isolation-dir capability-control kill) || true; fi; rm -rf "$fixture"' EXIT
expression='let
  repo = builtins.toPath (builtins.getEnv "BUCK2_PRODUCTS_REPO");
  f = builtins.getFlake ("git+file://" + toString repo + "?shallow=1");
  packages = f.packages.${builtins.currentSystem};
  product = packages.typescript-api-server.buck2Product;
in { inherit packages product; }'
contract="$(nix eval --impure --json --expr "let x = $expression; in {
  source = toString x.product.source;
  root = toString x.product.rootProjection;
  buck2 = toString x.packages.buck2;
  archives = toString x.product.pnpmArchives;
  target = x.product.target;
  declared = x.product.capabilities.requiredCapabilities;
}")"
unknown="$(nix eval --impure --json --expr "let x = $expression; in (builtins.tryEval ((x.packages.buck2-capabilities.select [ \"undeclared-tool\" ]).drvPath)).success")"
[[ "$unknown" == false ]] || { printf 'Unknown producer capability was accepted\n' >&2; exit 1; }
buck2="$(jq -r .buck2 <<<"$contract")/bin/buck2"
mkdir -p "$fixture/root" "$fixture/home"
cp -R "$(jq -r .source <<<"$contract")/." "$fixture/root/"
cp -R "$(jq -r .root <<<"$contract")/." "$fixture/root/"
chmod -R u+w "$fixture/root"
export HOME="$fixture/home"
export XDG_CACHE_HOME="$fixture/cache"
export XDG_RUNTIME_DIR="$fixture/runtime"
archives="$(jq -r .archives <<<"$contract")"
target="$(jq -r .target <<<"$contract")"

analyze() {
  (cd "$fixture/root" && "$buck2" --isolation-dir capability-control cquery \
    --config "nix_store.root=$archives" --console simple "$target")
}
install_projection() {
  rm -rf "$fixture/root/.buck2/capabilities"
  mkdir -p "$fixture/root/.buck2/capabilities"
  cp -R "$1/." "$fixture/root/.buck2/capabilities/"
  chmod -R u+w "$fixture/root/.buck2/capabilities"
}
positive="$(nix build --impure --no-link --print-out-paths --expr "let x = $expression; in x.product.capabilities")"
install_projection "$positive"
analyze
(cd "$fixture/root" && "$buck2" --isolation-dir capability-control kill)
negative="$(nix build --impure --no-link --print-out-paths --expr "let x = $expression; in x.packages.buck2-capabilities.select (builtins.filter (name: name != \"product\") x.product.capabilities.requiredCapabilities)")"
install_projection "$negative"
if failure="$(analyze 2>&1)"; then
  printf 'Undeclared product capability unexpectedly passed analysis\n' >&2
  exit 1
fi
[[ "$failure" == *"product_tool"* && "$failure" == *"Unknown target"* ]] || {
  printf 'Negative control failed for an unrelated reason:\n%s\n' "$failure" >&2
  exit 1
}
printf 'Capability declaration negative control passed: declared product_tool analyzes; omitted product_tool is rejected\n'
