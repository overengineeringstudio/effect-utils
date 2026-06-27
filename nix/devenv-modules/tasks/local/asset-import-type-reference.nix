{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  git = "${pkgs.git}/bin/git";
in
{
  tasks."lint:check:asset-import-needs-type-reference" = {
    description = "Require a /// <reference> for asset side-effect imports in compiled source";
    exec = trace.exec "lint:check:asset-import-needs-type-reference" ''
      set -euo pipefail

      # A bare `import '...css'` (or scss/sass/less) in compiled, exported source needs an ambient
      # `*.css` declaration to type it. If that ambient lives only in a floating `.d.ts` pulled in
      # by this package's own tsconfig `include`, it does NOT travel into a downstream consumer
      # that compiles this source via `exports`-resolution — the side-effect import then fails with
      # TS2882 (see #837). A `/// <reference path|types ...>` directive in the SAME file is part of
      # that file's load graph, so the declaration travels into every program that compiles it.
      #
      # This guard requires that any compiled-source file with an asset side-effect import also
      # carries a `/// <reference>`. It runs out-of-band (an inline `oxlint-disable` of
      # `no-unassigned-import` cannot suppress it). Exempts the globs where side-effect imports are
      # allowed and not type-checked into downstream graphs: `.storybook/**`, `*.gen.*`, `*.d.ts`,
      # `*.test.*`, `*.stories.*`.
      offenders=$(
        {
          ${git} ls-files -- 'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
            'context/**/*.ts' 'context/**/*.tsx'
          ${git} ls-files --others --exclude-standard -- \
            'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' \
            'context/**/*.ts' 'context/**/*.tsx'
        } | sort -u | while IFS= read -r f; do
          [ -z "$f" ] && continue
          case "$f" in
            */.storybook/*|*.gen.*|*.d.ts|*.test.*|*.stories.*) continue ;;
          esac
          ${pkgs.gawk}/bin/awk '
            /^[[:space:]]*import[[:space:]]+['"'"'"][^'"'"'"]*\.(css|scss|sass|less)['"'"'"]/ { asset = 1 }
            /^[[:space:]]*\/\/\/[[:space:]]*<reference[[:space:]]/ { ref = 1 }
            END { if (asset == 1 && ref != 1) print FILENAME }
          ' "$f"
        done | sort -u
      )
      if [ -n "$offenders" ]; then
        echo "Asset side-effect import without a travelling type reference in compiled source:"
        echo "$offenders"
        echo ""
        echo "Add a '/// <reference path=\"...\" />' to a shipped '*.css' ambient in the importing"
        echo "file so the declaration travels into downstream TS checks (see #837), or move the"
        echo "import under a '.storybook/*' entry that is not type-checked downstream."
        exit 1
      fi
      echo "All asset side-effect imports in compiled source carry a type reference"
    '';
  };

  tasks."lint:check".after = lib.mkAfter [ "lint:check:asset-import-needs-type-reference" ];
}
