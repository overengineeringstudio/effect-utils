#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"

contract_expr='repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  valid = {
    schema = "buck-build-product/v1";
    name = "fixture-tool";
    platform = {
      os = "linux";
      architecture = "x86_64";
      abi = "musl";
    };
    payload = {
      file = "artifact.tar";
      format = "tar";
      digest = {
        algorithm = "sha256";
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };
      sizeBytes = 123;
    };
    entrypoints = [ "bin/fixture-tool" ];
    runtime = {
      kind = "self-contained";
      inspectionContract = "elf-static/v1";
    };
    semanticProvenance = {
      target = "//fixtures:tool";
      recipe = "fixture-tool/v1";
      toolchain = "rust-linux-musl/v1";
    };
  };'

eval_raw() {
  nix eval --impure --raw --expr "let $contract_expr in $1"
}

expect_eval_failure() {
  local label="$1"
  local expected="$2"
  local expression="$3"
  local log
  log="$(mktemp)"
  if eval_raw "$expression" >"$log" 2>&1; then
    echo "buck2-build-product-contract-test: expected $label to fail" >&2
    rm -f "$log"
    exit 1
  fi
  if ! grep -F "$expected" "$log" >/dev/null; then
    echo "buck2-build-product-contract-test: $label failed without expected diagnostic: $expected" >&2
    sed -n '1,160p' "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  echo "buck2-build-product-contract-test: RED $label"
}

canonical="$(eval_raw 'contract.canonicalDescriptorJson valid')"
[ "$canonical" = "$(eval_raw 'contract.canonicalDescriptorJson valid')" ]
expected_canonical='{"entrypoints":["bin/fixture-tool"],"name":"fixture-tool","payload":{"digest":{"algorithm":"sha256","sri":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"file":"artifact.tar","format":"tar","sizeBytes":123},"platform":{"abi":"musl","architecture":"x86_64","os":"linux"},"runtime":{"inspectionContract":"elf-static/v1","kind":"self-contained"},"schema":"buck-build-product/v1","semanticProvenance":{"recipe":"fixture-tool/v1","target":"//fixtures:tool","toolchain":"rust-linux-musl/v1"}}'
[ "$canonical" = "$expected_canonical" ] || {
  echo "buck2-build-product-contract-test: canonical descriptor bytes changed" >&2
  exit 1
}

descriptor_digest="$(eval_raw 'contract.descriptorDigest valid')"
[ "$descriptor_digest" = "sha256:920dafd10e3eb7c3d54a0ef6d80213a58ceac533019537cb9e7098177b72389d" ] || {
  echo "buck2-build-product-contract-test: canonical descriptor digest changed: $descriptor_digest" >&2
  exit 1
}

verified="$(eval_raw 'contract.canonicalDescriptorJson (contract.verifyDescriptor {
  descriptor = valid;
  expectedDescriptorDigest = contract.descriptorDigest valid;
})')"
[ "$verified" = "$canonical" ]

expect_eval_failure \
  "missing independent descriptor digest" \
  "expectedDescriptorDigest must be a sha256 digest" \
  'contract.canonicalDescriptorJson (contract.verifyDescriptor {
    descriptor = valid;
    expectedDescriptorDigest = "";
  })'

expect_eval_failure \
  "wrong independent descriptor digest" \
  "descriptor digest mismatch" \
  'contract.canonicalDescriptorJson (contract.verifyDescriptor {
    descriptor = valid;
    expectedDescriptorDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  })'

expect_eval_failure \
  "unknown descriptor field" \
  "descriptor has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // { surprise = true; })'

expect_eval_failure \
  "unknown nested payload field" \
  "descriptor.payload has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // { surprise = true; };
  })'

expect_eval_failure \
  "unknown nested digest field" \
  "descriptor.payload.digest has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // { surprise = true; };
    };
  })'

expect_eval_failure \
  "unknown nested platform field" \
  "descriptor.platform has unknown fields: surprise" \
  'contract.canonicalDescriptorJson (valid // {
    platform = valid.platform // { surprise = true; };
  })'

expect_eval_failure \
  "evidence provenance in semantic descriptor" \
  "descriptor has unknown fields: evidenceProvenance" \
  'contract.canonicalDescriptorJson (valid // {
    evidenceProvenance = { invocationId = "invocation-1"; };
  })'

expect_eval_failure \
  "action identity in semantic provenance" \
  "descriptor.semanticProvenance has unknown fields: actionDigest" \
  'contract.canonicalDescriptorJson (valid // {
    semanticProvenance = valid.semanticProvenance // { actionDigest = "action-1"; };
  })'

expect_eval_failure \
  "unknown runtime variant" \
  "unsupported runtime kind: wasm-magic" \
  'contract.canonicalDescriptorJson (valid // {
    runtime = { kind = "wasm-magic"; };
  })'

expect_eval_failure \
  "unknown runtime field" \
  "descriptor.runtime has unknown fields: assumedPortable" \
  'contract.canonicalDescriptorJson (valid // {
    runtime = valid.runtime // { assumedPortable = true; };
  })'

expect_eval_failure \
  "newline entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\nunsafe" ];
  })'

expect_eval_failure \
  "carriage-return entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\runsafe" ];
  })'

semantic_change_digest="$(eval_raw 'contract.descriptorDigest (valid // {
  semanticProvenance = valid.semanticProvenance // { recipe = "fixture-tool/v2"; };
})')"
[ "$semantic_change_digest" != "$descriptor_digest" ] || {
  echo "buck2-build-product-contract-test: semantic provenance did not change descriptor identity" >&2
  exit 1
}

expect_eval_failure \
  "duplicate entrypoint" \
  "descriptor.entrypoints entries must be unique" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture-tool" "bin/fixture-tool" ];
  })'

for variant in interpreter elf-dynamic mach-o-dynamic self-contained; do
  case "$variant" in
    interpreter)
      runtime='{ kind = "interpreter"; runtimeId = "bun"; runtimeContract = "bun-1.2/v1"; program = "bin/fixture-tool"; }'
      ;;
    elf-dynamic)
      runtime='{ kind = "elf-dynamic"; machine = "x86_64"; loaderClass = "glibc"; neededLibraries = [ "libc.so.6" ]; symbolVersionFloors = [ "GLIBC_2.39" ]; runpathPolicy = "nix-realized/v1"; }'
      ;;
    mach-o-dynamic)
      runtime='{ kind = "mach-o-dynamic"; architecture = "arm64"; minimumOs = "14.0"; dylibs = [ "/usr/lib/libSystem.B.dylib" ]; installNamePolicy = "system-only/v1"; rpathPolicy = "none/v1"; signingPolicy = "adhoc/v1"; }'
      ;;
    self-contained)
      runtime='{ kind = "self-contained"; inspectionContract = "elf-static/v1"; }'
      ;;
  esac
  eval_raw "contract.descriptorDigest (valid // { runtime = $runtime; })" >/dev/null
done

echo "buck2-build-product-contract-test: PASS digest=$descriptor_digest"
