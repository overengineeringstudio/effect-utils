# Weaver LIVE-CHECK e2e gate (SC-R12; additive; GEN-R09 block-vs-degrade)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.weaver-live-check {}) ];
#
# Provides: weaver:live-check
#
# Runs the live-check e2e (a scoped Vitest integration test): a first-party telemetry site emits
# registry-conformant OTLP through the real otel-contract encoder, the otelite capture harness
# records the on-the-wire OTLP, an adapter projects it into weaver's live-check sample format, and
# `weaver registry live-check` validates it against the ACTUALLY-EMITTED registry
# (genie/weaver-registry/) — asserting exit 0 (conforms) plus a negative control (an undeclared
# attribute → nonzero). Upstream OTel semconv is resolved HERMETICALLY against the local Nix FOD
# (`nix/weaver-flake#semconv-model`), identical to weaver:check (SC-A03) — no network at gate time.
#
# The weaver binary + semconv-model path are handed to the test via WEAVER_BIN / WEAVER_SEMCONV_MODEL
# (mirroring how the otelite tests take OTELITE_BIN); the test SKIPS when they are absent, so the
# ordinary `test` lane (which does not build the heavy weaver flake) stays green and fast.
#
# Block-vs-degrade (GEN-R09), mirroring weaver:check: a live-check VALIDATION failure (the test
# fails) BLOCKS; weaver UNAVAILABILITY (flake build/eval failure, binary missing) DEGRADES to a
# warning (exit 0) in a separate lane.
{
  # Repo-relative path to the emitted registry directory (passed to the test for hermetic rewrite).
  registryDir ? "genie/weaver-registry",
  # Path flake ref (relative to repo root) exposing `#weaver` and `#semconv-model`.
  weaverFlake ? "nix/weaver-flake",
  # Package the e2e test lives in (has the demo contract + the otelite harness dev-dep).
  packagePath ? "packages/@overeng/otel-contract",
  # The single e2e test file to run (relative to packagePath).
  testFile ? "src/registry-live-check.integration.test.ts",
  # Install task the vitest run depends on.
  installTask ? "pnpm:install",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
in
{
  tasks = {
    "weaver:live-check" = {
      description = "Validate emitted OTLP against the Weaver registry via live-check e2e (additive gate; degrades if weaver is unavailable)";
      cwd = packagePath;
      after = [ installTask ];
      exec = trace.exec "weaver:live-check" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        flake="$root/${weaverFlake}"

        # --- LANE 1: weaver availability (degrade to a warning; must NOT wedge the gate) ---
        weaver_err="$(${pkgs.coreutils}/bin/mktemp)"
        if ! weaver_pkg="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#weaver" 2>"$weaver_err")"; then
          echo "⚠ weaver:live-check DEGRADED: could not build the weaver flake ($flake#weaver) — skipping (exit 0)." >&2
          ${pkgs.coreutils}/bin/cat "$weaver_err" >&2 || true
          exit 0
        fi
        if ! model="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#semconv-model" 2>"$weaver_err")"; then
          echo "⚠ weaver:live-check DEGRADED: could not materialize the upstream semconv FOD ($flake#semconv-model) — skipping (exit 0)." >&2
          ${pkgs.coreutils}/bin/cat "$weaver_err" >&2 || true
          exit 0
        fi
        if [ ! -x "$weaver_pkg/bin/weaver" ]; then
          echo "⚠ weaver:live-check DEGRADED: weaver binary missing at $weaver_pkg/bin/weaver — skipping (exit 0)." >&2
          exit 0
        fi

        # --- LANE 2: run the e2e (BLOCKS on failure) ---
        export WEAVER_BIN="$weaver_pkg/bin/weaver"
        export WEAVER_SEMCONV_MODEL="$model"
        export WEAVER_REGISTRY_DIR="$root/${registryDir}"

        echo "weaver:live-check: running ${registryDir} e2e with $WEAVER_BIN against upstream $model"
        source ${lib.escapeShellArg pnpmTaskHelpersScript}
        run_package_bin vitest vitest run --testTimeout 60000 --hookTimeout 60000 ${testFile}
      '';
    };
  };
}
