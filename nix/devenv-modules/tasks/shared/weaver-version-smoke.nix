# Weaver version-pin smoke check (SC-DQ4)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.weaver-version-smoke {}) ];
#
# Provides: weaver:version-smoke
#
# Asserts the pinned-version triad is INTERNALLY CONSISTENT + RESOLVABLE, catching
# version-pin DRIFT between the two sources of truth that a bump must keep in lockstep:
#   - `nix/weaver-flake/flake.nix`      : `version` (Weaver) + `semconvVersion` (upstream OTel)
#   - `genie/weaver-registry/registry.ts`: PINNED_WEAVER_VERSION + PINNED_UPSTREAM_SEMCONV_VERSION
# (the registry pins feed the GEN-R07 provenance fingerprint, so they MUST track the flake).
# Companion runbook: packages/@overeng/genie/docs/generators/01-semantic-conventions/version-bump-runbook.md
#
# Block-vs-degrade (intentional DIVERGENCE from weaver:check / GEN-R09):
#   weaver:check degrades on a weaver-flake BUILD failure (it gates registry CONTENT, so a broken
#   toolchain must not wedge it). This smoke gates version INTEGRITY, so a build failure IS the
#   drift signal (e.g. a bumped `version` with a stale `src.hash` surfaces as an FOD mismatch that
#   weaver:check would silently degrade past). Therefore:
#     LANE A  string consistency (grep only, no nix)   → BLOCK on mismatch
#     LANE B  resolvability (nix build + weaver --version):
#               nix not on PATH (genuine unavailability) → DEGRADE (warn, exit 0)
#               build failure / version mismatch (DRIFT) → BLOCK
#   Only a truly absent `nix` degrades; everything else that a bump could break blocks.
{
  # Path flake ref (relative to repo root) exposing `#weaver` and `#semconv-model`.
  weaverFlake ? "nix/weaver-flake",
  # Repo-relative path to the flake pinning `version` + `semconvVersion`.
  flakeNix ? "nix/weaver-flake/flake.nix",
  # Repo-relative path to the registry aggregator exporting the PINNED_* constants.
  registryTs ? "genie/weaver-registry/registry.ts",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "weaver:version-smoke" = {
      description = "Assert the pinned Weaver + upstream-semconv versions are consistent and resolvable (drift smoke)";
      exec = trace.exec "weaver:version-smoke" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        flake="$root/${weaverFlake}"
        flake_nix="$root/${flakeNix}"
        reg_ts="$root/${registryTs}"

        grep="${pkgs.gnugrep}/bin/grep"

        for f in "$flake_nix" "$reg_ts"; do
          if [ ! -f "$f" ]; then
            echo "✗ weaver:version-smoke: $f not found" >&2
            exit 1
          fi
        done

        # --- LANE A: string consistency (hermetic, instant, no nix) — BLOCKS ---
        # flake.nix pins (lowercase `version` avoids matching `semconvVersion`'s capital V).
        flake_weaver="$("$grep" -oE 'version = "[0-9]+\.[0-9]+\.[0-9]+"' "$flake_nix" | "$grep" -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
        flake_semconv="$("$grep" -oE 'semconvVersion = "[0-9]+\.[0-9]+\.[0-9]+"' "$flake_nix" | "$grep" -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
        # registry.ts PINNED_* constants (single-quoted string literals).
        reg_weaver="$("$grep" -oE "PINNED_WEAVER_VERSION = '[^']+'" "$reg_ts" | "$grep" -oE "'[^']+'" | tr -d "'" | head -1)"
        reg_semconv="$("$grep" -oE "PINNED_UPSTREAM_SEMCONV_VERSION = '[^']+'" "$reg_ts" | "$grep" -oE "'[^']+'" | tr -d "'" | head -1)"

        fail=0
        if [ -z "$flake_weaver" ] || [ -z "$flake_semconv" ]; then
          echo "✗ weaver:version-smoke: could not parse version/semconvVersion from $flake_nix" >&2
          fail=1
        fi
        if [ -z "$reg_weaver" ] || [ -z "$reg_semconv" ]; then
          echo "✗ weaver:version-smoke: could not parse PINNED_* from $reg_ts" >&2
          fail=1
        fi
        # Weaver: identical strings. Semconv: registry carries a leading `v` (git tag form).
        if [ "$reg_weaver" != "$flake_weaver" ]; then
          echo "✗ weaver:version-smoke: Weaver pin DRIFT — flake.nix version=$flake_weaver vs registry.ts PINNED_WEAVER_VERSION=$reg_weaver" >&2
          fail=1
        fi
        if [ "$reg_semconv" != "v$flake_semconv" ]; then
          echo "✗ weaver:version-smoke: semconv pin DRIFT — flake.nix semconvVersion=$flake_semconv (expect registry 'v$flake_semconv') vs registry.ts PINNED_UPSTREAM_SEMCONV_VERSION=$reg_semconv" >&2
          fail=1
        fi
        if [ "$fail" -ne 0 ]; then
          echo "✗ weaver:version-smoke: version pins are INCONSISTENT — see version-bump-runbook.md" >&2
          exit 1
        fi
        echo "✓ weaver:version-smoke LANE A: pins consistent — Weaver $flake_weaver, semconv v$flake_semconv"

        # --- LANE B: resolvability (nix build + weaver --version) ---
        if ! command -v nix >/dev/null 2>&1; then
          echo "⚠ weaver:version-smoke DEGRADED: nix not on PATH — skipping resolvability (exit 0)." >&2
          exit 0
        fi

        # semconv FOD must materialize (a forgotten semconv hash refresh surfaces here — BLOCKS).
        if ! nix build --no-link --print-out-paths "$flake#semconv-model" >/dev/null; then
          echo "✗ weaver:version-smoke: could not build $flake#semconv-model — likely a stale semconv src.hash after a bump (refresh via nurl; see runbook)." >&2
          exit 1
        fi

        # weaver must build (a forgotten weaver src.hash / pnpmDeps.hash surfaces here — BLOCKS).
        if ! weaver_pkg="$(nix build --no-link --print-out-paths "$flake#weaver")"; then
          echo "✗ weaver:version-smoke: could not build $flake#weaver — likely a stale src.hash / pnpmDeps.hash after a bump (refresh hashes; see runbook)." >&2
          exit 1
        fi
        if [ ! -x "$weaver_pkg/bin/weaver" ]; then
          echo "✗ weaver:version-smoke: weaver binary missing at $weaver_pkg/bin/weaver" >&2
          exit 1
        fi

        # The BUILT binary's version must equal the pin (end-to-end: flake `version` ↔ real binary).
        built_weaver="$("$weaver_pkg/bin/weaver" --version | "$grep" -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
        if [ "$built_weaver" != "$flake_weaver" ]; then
          echo "✗ weaver:version-smoke: BUILT weaver reports $built_weaver but pins say $flake_weaver — flake version= diverged from the actual source tag." >&2
          exit 1
        fi

        echo "✓ weaver:version-smoke LANE B: built weaver $built_weaver + semconv v$flake_semconv resolve — pins are consistent and buildable"
      '';
    };
  };
}
