#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
export BUCK2_BRIDGE_REPO="$repo_root"
compiler_package="$(nix build --no-link --print-out-paths "$repo_root#buck2-rust-compiler")"
BUCK2_RUST_COMPILER_IDENTITY="$("$compiler_package/bin/rustc" --effect-utils-compiler-identity)"
if [[ -z "$BUCK2_RUST_COMPILER_IDENTITY" ]]; then
  echo "buck2-library-product-contract-test: real compiler capability returned an empty identity" >&2
  exit 1
fi
export BUCK2_RUST_COMPILER_IDENTITY
nix-instantiate --eval --strict --expr '
let
  repo = builtins.toPath (builtins.getEnv "BUCK2_BRIDGE_REPO");
  contract = import (repo + "/nix/workspace-tools/lib/buck2-build-product-contract.nix");
  artifact = path: role: { inherit path role; sha256 = builtins.concatStringsSep "" (builtins.genList (_: "a") 64); };
  compiler = "/nix/store/00000000000000000000000000000000-rustc-1.90.0";
  version = host: "rustc 1.90.0 (fixture 2025-09-18)\nbinary: rustc\ncommit-hash: fixture\ncommit-date: 2025-09-18\nhost: ${host}\nrelease: 1.90.0\nLLVM version: 20.1.8\n";
  valid = {
    schema = "buck-rust-library-product/v1"; kind = "library"; name = "fixture-library";
    payload = { file = "artifact.tar"; format = "tar"; sizeBytes = 123;
      digest = { algorithm = "sha256"; sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; }; };
    platform = { os = "linux"; architecture = "aarch64"; abi = "glibc"; };
    semanticProvenance = { target = "//fixtures:library"; recipe = "rust-library/v1"; toolchain = "rust-native/v1"; };
    library = {
      language = "rust"; crateName = "fixture_library"; primary = "lib/libfixture_library.rlib"; dependencyDirectory = "lib";
      targetTriple = "aarch64-unknown-linux-gnu"; hostTriple = "aarch64-unknown-linux-gnu"; panicStrategy = "unwind";
      rustc = { compilerStorePath = compiler; sysroot = compiler;
        verboseVersion = version "aarch64-unknown-linux-gnu"; darwinWrapperEvidence = ""; };
      # Measured closure shape: primary, four hashed dependencies, two host macros.
      artifacts = [
        (artifact "lib/libdep_a-001.rlib" "rlib") (artifact "lib/libdep_b-002.rlib" "rlib")
        (artifact "lib/libdep_c-003.rlib" "rlib") (artifact "lib/libdep_d-004.rlib" "rlib")
        (artifact "lib/libderive_a-005.so" "proc-macro") (artifact "lib/libderive_b-006.so" "proc-macro")
        (artifact "lib/libfixture_library.rlib" "rlib")
      ];
    };
  };
  withLibrary = patch: valid // { library = valid.library // patch; };
  withArtifacts = artifacts: withLibrary { inherit artifacts; };
  rejects = descriptor: !(builtins.tryEval (builtins.deepSeq (contract.validateDescriptor descriptor) true)).success;
  objects = [
    { value = valid; replace = x: x; }
    { value = valid.payload; replace = x: valid // { payload = x; }; }
    { value = valid.payload.digest; replace = x: valid // { payload = valid.payload // { digest = x; }; }; }
    { value = valid.platform; replace = x: valid // { platform = x; }; }
    { value = valid.semanticProvenance; replace = x: valid // { semanticProvenance = x; }; }
    { value = valid.library; replace = x: valid // { library = x; }; }
    { value = valid.library.rustc; replace = x: withLibrary { rustc = x; }; }
    { value = builtins.head valid.library.artifacts; replace = x: withArtifacts ([ x ] ++ builtins.tail valid.library.artifacts); }
  ];
  darwin = valid // {
    platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };
    library = valid.library // { targetTriple = "aarch64-apple-darwin"; hostTriple = "aarch64-apple-darwin";
      rustc = valid.library.rustc // { verboseVersion = version "aarch64-apple-darwin"; darwinWrapperEvidence = "${compiler}/bin/rustc"; };
      artifacts = [ (artifact valid.library.primary "rlib") (artifact "lib/libmacro.dylib" "proc-macro") (artifact "lib/libmetadata.rmeta" "rmeta") ]; };
  };
  actualCompiler = builtins.fromJSON (builtins.getEnv "BUCK2_RUST_COMPILER_IDENTITY");
  actualHost = builtins.head (builtins.match ".*\nhost: ([^\n]+)\n.*" actualCompiler.verboseVersion);
  actual = valid // {
    platform = if actualHost == "aarch64-apple-darwin" then darwin.platform else valid.platform // {
      architecture = if actualHost == "x86_64-unknown-linux-gnu" then "x86_64" else "aarch64";
    };
    library = valid.library // { rustc = actualCompiler; hostTriple = actualHost; targetTriple = actualHost;
      artifacts = [ (artifact valid.library.primary "rlib") ]; };
  };
  synthesizedDarwin = darwin // { library = darwin.library // { rustc = actualCompiler // {
    verboseVersion = builtins.replaceStrings [ actualHost ] [ "aarch64-apple-darwin" ] actualCompiler.verboseVersion;
    darwinWrapperEvidence = "${actualCompiler.compilerStorePath}/bin/rustc";
  }; }; };
  negatives = [
    (valid // { kind = "executable"; }) (valid // { schema = "buck-build-product/v1"; }) (valid // { schema = "buck-rust-library-product/v2"; })
    (withLibrary { panicStrategy = "invalid"; }) (withLibrary { targetTriple = "x86_64-unknown-linux-gnu"; })
    (withArtifacts (builtins.tail valid.library.artifacts ++ [ (builtins.head valid.library.artifacts) ]))
    (withArtifacts (valid.library.artifacts ++ [ (builtins.head valid.library.artifacts) ]))
    (withArtifacts [ (builtins.head valid.library.artifacts) ]) (withArtifacts [ (artifact valid.library.primary "rlib") (artifact valid.library.primary "rlib") ])
    (withArtifacts [ (artifact valid.library.primary "rmeta") ])
    (withArtifacts [ ((artifact valid.library.primary "rlib") // { sha256 = "tampered"; }) ])
    (withLibrary { rustc = valid.library.rustc // { verboseVersion = version "aarch64-apple-darwin"; }; })
    (withLibrary { rustc = valid.library.rustc // { verboseVersion = version valid.library.hostTriple + "\n"; }; })
    (withLibrary { rustc = valid.library.rustc // { compilerStorePath = "/tmp/rustc"; }; })
    (darwin // { library = darwin.library // { artifacts = [ (artifact valid.library.primary "rlib") (artifact "lib/libmacro.so" "proc-macro") ]; }; })
  ] ++ map (path: withArtifacts [ (artifact valid.library.primary "rlib") (artifact path "rlib") ]) [
    "../lib/libbad.rlib" "lib/../libbad.rlib" "/lib/libbad.rlib" "lib/sub/libbad.rlib" "lib//libbad.rlib" "lib/libbad\\name.rlib" "lib/libbad.a"
  ] ++ [ (withArtifacts [ (artifact valid.library.primary "rlib") (artifact "lib/libmacro.dylib" "proc-macro") ]) ];
in
assert contract.validateDescriptor valid == valid && contract.validateDescriptor darwin == darwin;
assert contract.validateDescriptor actual == actual;
assert contract.validateDescriptor synthesizedDarwin == synthesizedDarwin;
assert contract.validateDescriptor (withLibrary { panicStrategy = "abort"; }) != null;
assert builtins.all (object: rejects (object.replace (object.value // { unknown = true; })) && builtins.all (field: rejects (object.replace (builtins.removeAttrs object.value [ field ]))) (builtins.attrNames object.value)) objects;
assert builtins.all rejects negatives;
assert contract.verifyDescriptor { descriptor = valid; expectedDescriptorDigest = contract.descriptorDigest valid; } == valid;
assert !(builtins.tryEval (builtins.deepSeq (contract.verifyDescriptor { descriptor = withLibrary { crateName = "tampered"; primary = "lib/libtampered.rlib"; artifacts = [ (artifact "lib/libtampered.rlib" "rlib") ]; }; expectedDescriptorDigest = contract.descriptorDigest valid; }) true)).success;
"buck2-library-product-contract-test: PASS"
'

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
  };
  validMachO = valid // {
    platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "arm64";
      minimumOs = "14.0";
      dylibs = [ "/usr/lib/libSystem.B.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  };
  bundleExecutable = {
    path = "Applications/Fixture.app/Contents/MacOS/fixture";
    inherit (validMachO.runtime) architecture dylibs minimumOs signingPolicy;
  };
  validBundle = validMachO // {
    entrypoints = [ bundleExecutable.path ];
    runtime = {
      kind = "mach-o-app-bundle";
      inspectionContract = "mach-o-app-bundle/v1";
      bundleRoot = "Applications/Fixture.app";
      mainExecutable = bundleExecutable.path;
      executables = [ bundleExecutable ];
      inherit (validMachO.runtime) installNamePolicy rpathPolicy;
    };
  };
  validWasm = valid // {
    entrypoints = [ "lib/guest.wasm" ];
    platform = { os = "wasm"; architecture = "wasm32"; abi = "unknown"; };
    runtime = {
      exports = [ { name = "answer"; kind = "function"; } ];
      harness = "fixture-harness/v1";
      imports = [ ];
      inspectionContract = "wasm32-unknown-unknown/v1";
      kind = "wasm-guest";
      targetTriple = "wasm32-unknown-unknown";
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

eval_raw 'builtins.deepSeq (contract.validateDescriptor validBundle) "accepted bundle"' >/dev/null
expect_eval_failure \
  "bundle executable outside bundle" \
  "executables must live inside the bundle root" \
  'contract.canonicalDescriptorJson (validBundle // { runtime = validBundle.runtime // {
    executables = [ (bundleExecutable // { path = "Applications/Other.app/tool"; }) ];
  }; })'
expect_eval_failure \
  "bundle runtime architecture mismatch" \
  "bundle executable architecture must match" \
  'contract.canonicalDescriptorJson (validBundle // { runtime = validBundle.runtime // {
    executables = [ (bundleExecutable // { architecture = "x86_64"; }) ];
  }; })'
expect_eval_failure \
  "bundle install name outside system" \
  "bundle executable dylibs must use system install names" \
  'contract.canonicalDescriptorJson (validBundle // { runtime = validBundle.runtime // {
    executables = [ (bundleExecutable // { dylibs = [ "/nix/store/foreign/lib.dylib" ]; }) ];
  }; })'
expect_eval_failure \
  "bundle duplicate executable" \
  "executables paths must be unique" \
  'contract.canonicalDescriptorJson (validBundle // { runtime = validBundle.runtime // {
    executables = [ bundleExecutable bundleExecutable ];
  }; })'
expect_eval_failure \
  "bundle undeclared main executable" \
  "mainExecutable must name a declared bundle executable" \
  'contract.canonicalDescriptorJson (validBundle // { runtime = validBundle.runtime // {
    mainExecutable = "Applications/Fixture.app/Contents/MacOS/absent";
  }; })'

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

wasm_digest="$(eval_raw 'contract.descriptorDigest validWasm')"
changed_wasm_digest="$(eval_raw 'contract.descriptorDigest (validWasm // {
  runtime = validWasm.runtime // { exports = [ { name = "answer"; kind = "global"; } ]; };
})')"
[ "$wasm_digest" != "$changed_wasm_digest" ] || {
  echo "buck2-build-product-contract-test: wasm export kind did not change descriptor identity" >&2
  exit 1
}

expect_eval_failure \
  "missing wasm exports" \
  "descriptor.runtime is missing fields: exports" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = builtins.removeAttrs validWasm.runtime [ "exports" ];
  })'

expect_eval_failure \
  "non-list wasm exports" \
  "descriptor.runtime.exports must be a list" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = {}; };
  })'

expect_eval_failure \
  "non-object wasm export" \
  "descriptor.runtime.exports entry must be an attribute set" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ "answer" ]; };
  })'

expect_eval_failure \
  "missing wasm export kind" \
  "descriptor.runtime.exports entry is missing fields: kind" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ { name = "answer"; } ]; };
  })'

expect_eval_failure \
  "missing wasm export name" \
  "descriptor.runtime.exports entry is missing fields: name" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ { kind = "function"; } ]; };
  })'

expect_eval_failure \
  "unknown wasm export field" \
  "descriptor.runtime.exports entry has unknown fields: signature" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // {
      exports = [ { name = "answer"; kind = "function"; signature = "() -> i32"; } ];
    };
  })'

expect_eval_failure \
  "non-string wasm export name" \
  "descriptor.runtime.exports entry.name must be a string" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ { name = 42; kind = "function"; } ]; };
  })'

expect_eval_failure \
  "unsupported wasm export kind" \
  "descriptor.runtime.exports entry.kind must be function, table, memory, global, or tag" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ { name = "answer"; kind = "func"; } ]; };
  })'

expect_eval_failure \
  "non-string wasm export kind" \
  "descriptor.runtime.exports entry.kind must be function, table, memory, global, or tag" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // { exports = [ { name = "answer"; kind = 0; } ]; };
  })'

expect_eval_failure \
  "duplicate wasm export names" \
  "descriptor.runtime.exports names must be unique" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // {
      exports = [ { name = "answer"; kind = "function"; } { name = "answer"; kind = "global"; } ];
    };
  })'

expect_eval_failure \
  "unsorted wasm exports" \
  "descriptor.runtime.exports must be sorted by name" \
  'contract.canonicalDescriptorJson (validWasm // {
    runtime = validWasm.runtime // {
      exports = [ { name = "z"; kind = "function"; } { name = "a"; kind = "function"; } ];
    };
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

expect_eval_failure \
  "tab entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ "bin/fixture\tunsafe" ];
  })'

expect_eval_failure \
  "escape entrypoint" \
  "descriptor.entrypoints must be safe relative paths" \
  'contract.canonicalDescriptorJson (valid // {
    entrypoints = [ (builtins.fromJSON "\"bin/fixture\\u001bunsafe\"") ];
  })'

expect_eval_failure \
  "non-canonical sha256 trailing digit" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=";
      };
    };
  })'

expect_eval_failure \
  "missing sha256 padding" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      };
    };
  })'

expect_eval_failure \
  "sha256 digest of 31 bytes" \
  "descriptor.payload.digest.sri must be a sha256 SRI digest" \
  'contract.canonicalDescriptorJson (valid // {
    payload = valid.payload // {
      digest = valid.payload.digest // {
        sri = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
      };
    };
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

for variant in interpreter elf-dynamic elf-static mach-o-dynamic self-contained; do
  platform_override=''
  case "$variant" in
    interpreter)
      runtime='{ kind = "interpreter"; runtimeId = "bun"; runtimeContract = "bun-1.2/v1"; program = "bin/fixture-tool"; }'
      ;;
    elf-dynamic)
      runtime='{ kind = "elf-dynamic"; inspectionContract = "elf-dynamic/v1"; elfClass = "ELF64"; machine = "x86_64"; interpreter = "/lib64/ld-linux-x86-64.so.2"; neededLibraries = [ "libc.so.6" ]; symbolVersionFloors = [ "GLIBC_2.39" ]; rpathPolicy = "empty/v1"; }'
      platform_override='platform = valid.platform // { abi = "glibc"; };'
      ;;
    elf-static)
      runtime='{ kind = "elf-static"; inspectionContract = "elf-static/v1"; elfClass = "ELF64"; machine = "x86_64"; }'
      platform_override='platform = valid.platform // { abi = "glibc"; };'
      ;;
    mach-o-dynamic)
      runtime='{ kind = "mach-o-dynamic"; inspectionContract = "mach-o-dynamic/v1"; architecture = "arm64"; minimumOs = "14.0"; dylibs = [ "/usr/lib/libSystem.B.dylib" ]; installNamePolicy = "system-only/v1"; rpathPolicy = "empty/v1"; signingPolicy = "adhoc/v1"; }'
      platform_override='platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };'
      ;;
    self-contained)
      runtime='{ kind = "self-contained"; inspectionContract = "elf-static/v1"; }'
      ;;
  esac
  eval_raw "contract.descriptorDigest (valid // { $platform_override runtime = $runtime; })" >/dev/null
done

expect_eval_failure \
  "Mach-O runtime on Linux" \
  "mach-o-dynamic requires descriptor.platform.os = darwin" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "x86_64";
      minimumOs = "14.0";
      dylibs = [ "/usr/lib/libSystem.B.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  })'

expect_eval_failure \
  "Mach-O non-system install name" \
  "descriptor.runtime.dylibs must use system install names" \
  'contract.descriptorDigest (valid // {
    platform = { os = "darwin"; architecture = "aarch64"; abi = "darwin"; };
    runtime = {
      kind = "mach-o-dynamic";
      inspectionContract = "mach-o-dynamic/v1";
      architecture = "arm64";
      minimumOs = "14.0";
      dylibs = [ "@rpath/libprivate.dylib" ];
      installNamePolicy = "system-only/v1";
      rpathPolicy = "empty/v1";
      signingPolicy = "adhoc/v1";
    };
  })'

expect_eval_failure \
  "missing Mach-O inspection contract" \
  "descriptor.runtime is missing fields: inspectionContract" \
  'contract.descriptorDigest (validMachO // {
    runtime = builtins.removeAttrs validMachO.runtime [ "inspectionContract" ];
  })'

expect_eval_failure \
  "wrong Mach-O inspection contract" \
  "descriptor.runtime.inspectionContract must be mach-o-dynamic/v1" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { inspectionContract = "mach-o-dynamic/v2"; };
  })'

expect_eval_failure \
  "unknown Mach-O runtime field" \
  "descriptor.runtime has unknown fields: universal" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { universal = true; };
  })'

expect_eval_failure \
  "Mach-O ABI mismatch" \
  "mach-o-dynamic/v1 requires descriptor.platform.abi = darwin" \
  'contract.descriptorDigest (validMachO // {
    platform = validMachO.platform // { abi = "none"; };
  })'

expect_eval_failure \
  "Mach-O architecture mismatch" \
  "descriptor.runtime.architecture must match descriptor.platform.architecture" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { architecture = "x86_64"; };
  })'

expect_eval_failure \
  "malformed Mach-O minimum OS" \
  "descriptor.runtime.minimumOs must be a canonical version" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { minimumOs = "14"; };
  })'

expect_eval_failure \
  "unsorted Mach-O dylibs" \
  "descriptor.runtime.dylibs must be sorted" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // {
      dylibs = [ "/usr/lib/libz.dylib" "/usr/lib/libSystem.B.dylib" ];
    };
  })'

expect_eval_failure \
  "duplicate Mach-O dylib" \
  "descriptor.runtime.dylibs entries must be unique" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // {
      dylibs = [ "/usr/lib/libSystem.B.dylib" "/usr/lib/libSystem.B.dylib" ];
    };
  })'

expect_eval_failure \
  "Mach-O dylib control character" \
  "descriptor.runtime.dylibs entries must not contain control characters" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { dylibs = [ "/usr/lib/libSystem.B.dylib\n" ]; };
  })'

expect_eval_failure \
  "Mach-O RPATH policy mismatch" \
  "descriptor.runtime.rpathPolicy must be empty/v1" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { rpathPolicy = "declared/v1"; };
  })'

embedded_mach_o_digest="$(eval_raw 'contract.descriptorDigest (validMachO // {
  runtime = validMachO.runtime // { signingPolicy = "embedded/v1"; };
})')"
[[ "$embedded_mach_o_digest" =~ ^sha256:[0-9a-f]{64}$ ]]

expect_eval_failure \
  "Mach-O signing policy mismatch" \
  "descriptor.runtime.signingPolicy is unsupported" \
  'contract.descriptorDigest (validMachO // {
    runtime = validMachO.runtime // { signingPolicy = "unsigned/v1"; };
  })'

expect_eval_failure \
  "missing ELF inspection contract" \
  "descriptor.runtime is missing fields: inspectionContract" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "legacy ELF runtime field" \
  "descriptor.runtime has unknown fields: loaderClass" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
      loaderClass = "glibc";
    };
  })'

expect_eval_failure \
  "ELF machine and platform architecture mismatch" \
  "descriptor.runtime.machine must match descriptor.platform.architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "aarch64";
      interpreter = "/lib/ld-linux-aarch64.so.1";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "static ELF machine and platform architecture mismatch" \
  "descriptor.runtime.machine must match descriptor.platform.architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-static";
      inspectionContract = "elf-static/v1";
      elfClass = "ELF64";
      machine = "aarch64";
    };
  })'

expect_eval_failure \
  "static ELF on a non-Linux platform" \
  "elf-static requires descriptor.platform.os = linux" \
  'contract.descriptorDigest (valid // {
    platform = { os = "darwin"; architecture = "x86_64"; abi = "glibc"; };
    runtime = {
      kind = "elf-static";
      inspectionContract = "elf-static/v1";
      elfClass = "ELF64";
      machine = "x86_64";
    };
  })'

expect_eval_failure \
  "dynamic ELF on a non-Linux platform" \
  "elf-dynamic requires descriptor.platform.os = linux" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { os = "darwin"; abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "dynamic ELF ABI mismatch" \
  "currently requires descriptor.platform.abi = glibc" \
  'contract.descriptorDigest (valid // {
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib64/ld-linux-x86-64.so.2";
      neededLibraries = [ "libc.so.6" ];
      symbolVersionFloors = [ "GLIBC_2.39" ];
      rpathPolicy = "empty/v1";
    };
  })'

expect_eval_failure \
  "dynamic ELF loader and ABI mismatch" \
  "interpreter does not prove the declared glibc architecture" \
  'contract.descriptorDigest (valid // {
    platform = valid.platform // { abi = "glibc"; };
    runtime = {
      kind = "elf-dynamic";
      inspectionContract = "elf-dynamic/v1";
      elfClass = "ELF64";
      machine = "x86_64";
      interpreter = "/lib/ld-musl-x86_64.so.1";
      neededLibraries = [ "libc.so" ];
      symbolVersionFloors = [ ];
      rpathPolicy = "empty/v1";
    };
  })'

for field in neededLibraries symbolVersionFloors; do
  expect_eval_failure \
    "dynamic ELF $field control character" \
    "descriptor.runtime.$field entries must not contain control characters" \
    "contract.descriptorDigest (valid // {
      platform = valid.platform // { abi = \"glibc\"; };
      runtime = {
        kind = \"elf-dynamic\";
        inspectionContract = \"elf-dynamic/v1\";
        elfClass = \"ELF64\";
        machine = \"x86_64\";
        interpreter = \"/lib64/ld-linux-x86-64.so.2\";
        neededLibraries = if \"$field\" == \"neededLibraries\" then [ \"libone.so\\nlibtwo.so\" ] else [ \"libc.so.6\" ];
        symbolVersionFloors = if \"$field\" == \"symbolVersionFloors\" then [ \"GLIBC_2.34\\nGLIBC_2.35\" ] else [ \"GLIBC_2.39\" ];
        rpathPolicy = \"empty/v1\";
      };
    })"
done

echo "buck2-build-product-contract-test: PASS digest=$descriptor_digest"
