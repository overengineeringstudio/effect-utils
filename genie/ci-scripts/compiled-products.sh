#!/usr/bin/env bash
#
# Build exported rules, retained shell and products; smoke executables and
# require installed-library consumer success plus diagnosed mismatch rejection.
# `--push` publishes each realized store path to the public Cachix cache
# (protected-main publisher only; needs CACHIX_AUTH_TOKEN).
#
# Product names are validated to [A-Za-z0-9._+-] by the Nix inventory loaders,
# so word splitting is safe; macOS runners ship Bash 3.2 (no `mapfile`).
set -euo pipefail

push=false
case "${1:-}" in
  '') ;;
  --push) push=true ;;
  *)
    echo "usage: $0 [--push]" >&2
    exit 2
    ;;
esac

# Use the same package graph as devenv's repoPackages. Evaluate it once for
# every inventoried import, the retained shell closure, and the Buck rules cell.
refs=(.#ci-test-shell-products .#buck2-rules)
product_names=()
product_attrs=()
product_checks=()
for inventory in nix/buck2-products/compiled-targets.json nix/buck2-products/native-targets.json; do
  rows=$(jq -r '.products[] | [.name, .kind] | @tsv' "$inventory")
  while IFS=$'\t' read -r name kind; do
    attr="$name"
    if [ "$inventory" = nix/buck2-products/compiled-targets.json ]; then
      attr="$name-compiled"
    fi
    check=''
    case "$kind" in
      rust-library)
        check=".#$name.libraryChecks"
        refs+=("$check")
        ;;
      native|compiled-executable) ;;
      *) echo "unsupported inventory kind: $kind" >&2; exit 1 ;;
    esac
    refs+=(".#$attr")
    product_names+=("$name")
    product_attrs+=("$attr")
    product_checks+=("$check")
  done <<< "$rows"
done
build_json=$(nix build --no-link --print-build-logs --json "${refs[@]}")
outputs=$(jq -er '.[] | .outputs.out // error("product build has no out output")' <<<"$build_json")

# Nix JSON reports derivations/outputs, not installable names. Match each
# inventory row by its executable rather than relying on result ordering.
# A missing or ambiguous import fails closed, preserving every smoke assertion.
for index in "${!product_names[@]}"; do
  name="${product_names[$index]}"
  attr="${product_attrs[$index]}"
  check="${product_checks[$index]}"
  if [ -n "$check" ]; then
    log=$(mktemp)
    if nix build --no-link --print-build-logs "$check.mismatch" >"$log" 2>&1; then
      cat "$log"; rm -f "$log"
      echo "product $attr: mismatched compiler unexpectedly accepted" >&2; exit 1
    fi
    cat "$log"
    for expected in 'library compiler identity mismatch' 'producer identity:' 'consumer identity:'; do
      if ! grep -Fq "$expected" "$log"; then
        rm -f "$log"; echo "product $attr: mismatch failed without $expected" >&2; exit 1
      fi
    done
    rm -f "$log"
    echo "product $attr: installed-library consumer and mismatch checks passed"
    continue
  fi
  matches=0
  out=''
  for candidate in $outputs; do
    if [ -x "$candidate/bin/$name" ]; then
      out="$candidate"
      matches=$((matches + 1))
    fi
  done
  if [ "$matches" -ne 1 ]; then
    echo "product $attr: expected one executable output, found $matches" >&2
    exit 1
  fi
  "$out/bin/$name" --help >/dev/null
  echo "product $attr: $out"
done

if [ "$push" = true ]; then
  # Store paths contain no whitespace; publish every exact direct output and
  # its transitive closure, including the retained shell and Buck rules cell.
  cachix push overeng-effect-utils $outputs
fi
