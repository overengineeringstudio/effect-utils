#!/usr/bin/env bash
set -euo pipefail

# Python surface boundary for the Buck graph.
#
# Decision 0028 admits exactly one Python term: the hermetic, Nix-realized
# `python_bootstrap` toolchain that prelude's own Rust rules require
# (`@prelude//rust/tools:transitive_dependency_symlinks` is a bootstrap binary).
# Everything else stays refused -- prelude's ambient system bootstrap toolchain,
# an interpreter bound to a bare basename off PATH, and every CPython
# build/action edge. Decision 0001 keeps this an allowlist: a form that is not
# enumerated below is a violation, not a judgement call.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Refused everywhere, regardless of the allowlist below. Each entry has a
# negative case at the bottom of this file, so the guard stays a guard.
BANNED_FORMS=(
  # CPython itself: building or bootstrapping an interpreter inside the graph.
  'cpython'
  # Prelude's ambient toolchains: they resolve the interpreter off PATH, which
  # splits action keys between a devenv shell and a bare CI runner.
  'system_python_bootstrap_toolchain'
  'system_python_wheel_toolchain'
  'remote_python_toolchain'
  'python_toolchain'
  # Python actions and libraries, first-party or prelude.
  'python_bootstrap_binary'
  'python_bootstrap_library'
  'python_binary'
  'python_library'
  'python_test'
  'python_wheel'
  'prelude//python:'
  # An interpreter reached by bare name rather than by store path.
  $'=[[:space:]]*["\']python[0-9.]*["\']'
  'env python'
  '#!.*python'
)

# The admitted realization, spelled out. Every form here is neutralized before
# the residual scan, so the residual scan can then refuse *any* remaining Python
# token instead of guessing at new spellings.
ALLOWED_FORMS_SED=(
  # The interpreter only ever arrives as an immutable store path...
  -e 's#/nix/store/[A-Za-z0-9._+-]+#<nix-store-path>#g'
  # ...whose relative executable is `bin/python3` (capability manifest field).
  -e 's#\bbin/python[0-9.]*\b#<nix-store-interpreter>#g'
  # The flake realization of that store path.
  -e 's#\bpkgs\.python[0-9.]*\b#<nix-interpreter-package>#g'
  # The basename literal the store-path shape assertion checks against. A bare
  # basename *bound* to the interpreter is banned above, and
  # `_require_nix_store_binary` additionally fails analysis for anything that is
  # not `/nix/store/<realization>/bin/python3`.
  -e $'s#["\']python3["\']#<interpreter-basename>#g'
  # The capability id, its flake package (`buck2-python-bootstrap`) and protocol.
  -e 's#python-bootstrap#<bootstrap-capability>#g'
  # The toolchain rule, its target name, the `toolchains//:python_bootstrap`
  # alias and prelude's load path.
  -e 's#python_bootstrap#<bootstrap-toolchain>#g'
  # Prelude's provider for it.
  -e 's#PythonBootstrapToolchainInfo#<bootstrap-provider>#g'
  # The human label carried in the store-path assertion's failure text.
  -e 's#Python bootstrap#<bootstrap-label>#g'
  # This guard's own name, cited by the code and decisions it constrains.
  -e 's#buck2-no-python-actions#<boundary-guard>#g'
)

# Returns 0 when the files carry no unadmitted Python surface.
scan_python_surface() {
  local status=0
  local file form matches

  for file in "$@"; do
    [ -f "$file" ] || continue

    for form in "${BANNED_FORMS[@]}"; do
      matches="$(grep -Ein -- "$form" "$file" || true)"
      if [ -n "$matches" ]; then
        echo "REFUSED: banned Python form '$form' in $file" >&2
        echo "$matches" >&2
        status=1
      fi
    done

    matches="$(sed -E "${ALLOWED_FORMS_SED[@]}" "$file" | grep -in python || true)"
    if [ -n "$matches" ]; then
      echo "REFUSED: Python token outside decision 0028's admitted realization in $file" >&2
      echo "$matches" >&2
      status=1
    fi
  done

  return "$status"
}

[ ! -e "$ROOT/buck2/rust/demo_toolchains.bzl" ] ||
  fail "dead Prelude demo toolchain projection still exists"

buck_sources=()
while IFS= read -r -d '' source; do
  buck_sources+=("$source")
done < <(
  find "$ROOT" \
    -type d \( \
      -name .devenv -o -name .git -o -name buck-out -o -name node_modules -o \
      -name target -o -path "$ROOT/context" -o -path "$ROOT/tmp" \
    \) -prune -o \
    -type f \( -name BUCK -o -name TARGETS -o -name '*.bzl' -o -name '*.bxl' \) \
    -print0
)

[ "${#buck_sources[@]}" -gt 0 ] || fail "Buck source inventory is empty"

projections=(
  "$ROOT/buck2-member.json"
  "$ROOT/buck2-member.json.genie.ts"
  "$ROOT/devenv.nix"
  "$ROOT/flake.nix"
)
while IFS= read -r -d '' projection; do
  projections+=("$projection")
done < <(
  find "$ROOT/nix" -maxdepth 1 -type f -name '*buck2*.nix' -print0 2>/dev/null
  find "$ROOT/scripts" -maxdepth 1 -type f -name 'buck2*.sh' -print0 2>/dev/null
)

scan_python_surface "${buck_sources[@]}" "${projections[@]}" ||
  fail "Buck graph carries Python surface outside decision 0028's hermetic python_bootstrap toolchain"

# The admitted realization must actually be admitted: a guard that rejects
# everything is as wrong as one that rejects nothing.
admitted="$TEMP_ROOT/admitted.bzl"
cat >"$admitted" <<'ADMITTED'
load("@prelude//python_bootstrap:python_bootstrap.bzl", "PythonBootstrapToolchainInfo")

def _nix_python_bootstrap_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.interpreter, "python3", "Python bootstrap")
    return [PythonBootstrapToolchainInfo(interpreter = ctx.attrs.interpreter)]

nix_python_bootstrap_toolchain(
    name = "python_bootstrap",
    interpreter = "/nix/store/mbpdm99j171pcs5ywxz49sdqq1fkijz0-python3/bin/python3",
)

toolchain_alias(
    name = "python_bootstrap",
    actual = "//buck2/toolchains:python_bootstrap",
)
ADMITTED
scan_python_surface "$admitted" ||
  fail "guard refuses the hermetic Nix-realized python_bootstrap toolchain that decision 0028 admits"

admitted_manifest="$TEMP_ROOT/admitted-manifest.json"
cat >"$admitted_manifest" <<'ADMITTED_MANIFEST'
{
  "toolchain": "python-bootstrap",
  "provides": [
    {
      "toolId": "python-bootstrap",
      "protocol": "effect-utils/buck2-python-bootstrap/v1",
      "flakePackage": "buck2-python-bootstrap",
      "executable": "bin/python3"
    }
  ]
}
ADMITTED_MANIFEST
scan_python_surface "$admitted_manifest" ||
  fail "guard refuses the projected python-bootstrap capability that decision 0028 admits"

admitted_projection="$TEMP_ROOT/admitted-capabilities.bzl"
cat >"$admitted_projection" <<'ADMITTED_PROJECTION'
CAPABILITIES = {
    "x86_64-linux": {
        "python-bootstrap": {
            "closureIdentity": "/nix/store/mbpdm99j171pcs5ywxz49sdqq1fkijz0-python3",
            "executableStorePath": "/nix/store/mbpdm99j171pcs5ywxz49sdqq1fkijz0-python3/bin/python3",
        },
    },
}
ADMITTED_PROJECTION
scan_python_surface "$admitted_projection" ||
  fail "guard refuses the .buck2/capabilities projection of the admitted bootstrap interpreter"

# One negative case per banned form, plus the unenumerated-spelling catch-all.
declare -A REFUSED_CASES=(
  [cpython-build-edge]='load("@prelude//toolchains:cpython.bzl", "cpython_toolchain")'
  [ambient-bootstrap-toolchain]='system_python_bootstrap_toolchain(name = "python_bootstrap")'
  [ambient-wheel-toolchain]='system_python_wheel_toolchain(name = "python_wheel")'
  [remote-toolchain]='remote_python_toolchain(name = "python_bootstrap")'
  [first-party-toolchain-rule]='python_toolchain(name = "py")'
  [bootstrap-binary-action]='python_bootstrap_binary(name = "helper", main = "helper.py")'
  [bootstrap-library-action]='python_bootstrap_library(name = "helpers", srcs = ["helper.py"])'
  [python-binary-action]='python_binary(name = "tool", main = "tool.py")'
  [python-library-action]='python_library(name = "lib", srcs = ["lib.py"])'
  [python-test-action]='python_test(name = "lib_test", srcs = ["lib_test.py"])'
  [python-wheel-action]='python_wheel(name = "dist", srcs = ["lib.py"])'
  [prelude-python-rules]='load("@prelude//python:python.bzl", "PythonLibraryInfo")'
  [bare-basename-interpreter]='    interpreter = "python3",'
  [path-lookup-interpreter]='    cmd = "env python3 build.py",'
  [shebang-interpreter]='#!/usr/bin/env python3'
  [path-invocation]='    cmd = "python3 -m compileall .",'
  [unenumerated-spelling]='    interpreter = require_python312_interpreter()'
)

for case_name in "${!REFUSED_CASES[@]}"; do
  refused="$TEMP_ROOT/refused-$case_name.bzl"
  printf '%s\n' "${REFUSED_CASES[$case_name]}" >"$refused"
  if scan_python_surface "$refused" 2>/dev/null; then
    fail "guard accepted a refused Python form ($case_name): ${REFUSED_CASES[$case_name]}"
  fi
done

echo "Buck Python boundary tests passed (${#REFUSED_CASES[@]} refused forms, 3 admitted forms)."
