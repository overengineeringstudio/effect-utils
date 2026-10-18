#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

eval_check_module() {
  local module_args="$1"
  local quick_task="$2"
  local all_task="$3"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
            config.tasks = pkgs.lib.genAttrs (pkgs.lib.unique [ "$quick_task" "$all_task" ]) (_: {
              exec = "true";
            });
          })
          (import $ROOT/nix/devenv-modules/tasks/shared/check.nix $module_args)
        ];
      };
      tasks = evaluated.config.tasks;
    in builtins.toJSON {
      allAfter = tasks.\"check:all\".after;
      hasAllTask = builtins.hasAttr "$all_task" tasks;
      hasQuickTask = builtins.hasAttr "$quick_task" tasks;
      quickAfter = tasks.\"check:quick\".after;
    }
  "
}

minimal_args='{ hasTests = false; hasLint = false; hasNixCheck = false; hasMegarepoCheck = false; }'
assert_eq \
  '{"allAfter":["ts:check"],"hasAllTask":true,"hasQuickTask":true,"quickAfter":["ts:check"]}' \
  "$(eval_check_module "$minimal_args" 'ts:check' 'ts:check')" \
  'compatibility default references the consumer-owned ts:check task'

buck_args='{ hasTests = false; hasLint = false; hasNixCheck = false; hasMegarepoCheck = false; checkQuickTypecheckTask = "buck2:quick"; checkAllTypecheckTask = "buck2:all"; }'
assert_eq \
  '{"allAfter":["buck2:all"],"hasAllTask":true,"hasQuickTask":true,"quickAfter":["buck2:quick"]}' \
  "$(eval_check_module "$buck_args" 'buck2:quick' 'buck2:all')" \
  'consumer may select explicit Buck aggregate tasks'

# Exercise the actual aggregate rendering and its host launcher, rather than
# assuming Buck2 accepts an invented environment-variable binary selector.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
host_watchman="$work/signed host watchman"
printf '#!%s\nprintf "host:%%s\\n" "$@"\n' "$BASH" > "$host_watchman"
chmod +x "$host_watchman"
watchman_expr="
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    evaluate = settings: (pkgs.lib.evalModules {
      modules = [
        $ROOT/nix/devenv-modules/tasks/shared/buck2.nix
        { effectUtils.buck2 = { eventsPackage = pkgs.emptyDirectory; } // settings; }
      ];
      specialArgs = { inherit pkgs; inputs = {}; };
    }).config.effectUtils.buck2;
    default = evaluate {};
    overridden = evaluate {
      watchmanBin = builtins.getEnv \"TEST_HOST_WATCHMAN\";
      prepare = \"watchman --output-encoding 'argument with spaces'; exit 0\";
    };
    render = cfg: cfg.aggregateExec \"fixture:watchman\" [ \"status\" ];
  in
"
export TEST_HOST_WATCHMAN="$host_watchman"
default_path_proof="$(nix eval --impure --json --expr "$watchman_expr {
  unchanged = pkgs.lib.hasInfix
    (builtins.unsafeDiscardStringContext (\"export PATH=\" + pkgs.lib.makeBinPath [ pkgs.watchman ] + \"\n\"))
    (render default);
  noAmbientPath = !(pkgs.lib.hasInfix \"\$PATH\" (render default));
  defaultIsNull = default.watchmanBin == null;
}")"
assert_eq '{"defaultIsNull":true,"noAmbientPath":true,"unchanged":true}' \
  "$default_path_proof" 'Linux default rendered PATH remains exactly nixpkgs Watchman'
launcher_test="$(nix build --impure --no-link --print-out-paths --expr \
  "$watchman_expr pkgs.writeShellScript \"buck2-watchman-override-test\" (render overridden)")"
# A hostile ambient PATH must neither win selection nor survive replacement.
# Isolate this launcher-only fixture from CI telemetry: an inherited absolute
# OTEL_SPAN_BIN would otherwise activate tracing, which needs bash on PATH.
actual="$(env -i PATH=/nonexistent DEVENV_ROOT="$work" "$BASH" "$launcher_test")"
assert_eq $'host:--output-encoding\nhost:argument with spaces' "$actual" \
  'override executes the exact host binary and preserves argument boundaries'
if nix eval --impure --raw --expr \
  "$watchman_expr (evaluate { watchmanBin = \"relative/watchman\"; }).watchmanBin" \
  >"$work/relative.stdout" 2>"$work/relative.stderr"; then
  echo 'FAIL: relative Watchman override accepted' >&2
  exit 1
fi
echo 'Watchman module tests passed: unchanged default PATH, explicit host override, relative override rejected.'
