# Pure protocol qualification only: no service, root policy or Linux dependency.
{ pkgs }:
let
  inherit (pkgs) lib;
  sources = [
    "worktree-holder-evidence-protocol-lib.rs"
    "worktree-holder-evidence-protocol.rs"
    "worktree-holder-evidence-request.rs"
    "worktree-holder-evidence-digest.rs"
    "worktree-holder-evidence-codec.rs"
  ];
  fixture =
    ../../../../. + "/packages/@overeng/megarepo/src/store/fixtures/worktree-holder-evidence-v1.jsonl";
in
pkgs.runCommand "holder-evidence-protocol-v1"
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    meta = {
      description = "Inactive std-only holder-evidence v1 protocol library and codec qualification";
      mainProgram = "holder-evidence-codec";
      platforms = lib.platforms.unix;
    };
  }
  ''
    mkdir -p source/nix/devenv-modules/tasks/shared
    mkdir -p source/packages/@overeng/megarepo/src/store/fixtures
    cp ${fixture} source/packages/@overeng/megarepo/src/store/fixtures/worktree-holder-evidence-v1.jsonl
    ${lib.concatMapStringsSep "\n" (
      name: "cp ${./. + "/${name}"} source/nix/devenv-modules/tasks/shared/${lib.escapeShellArg name}"
    ) sources}
    cd source/nix/devenv-modules/tasks/shared

    rustc --edition=2024 -D warnings --test worktree-holder-evidence-protocol-lib.rs -o protocol-tests
    ./protocol-tests

    mkdir -p "$out/lib" "$out/bin" "$out/share/holder-evidence-protocol/src"
    rustc --edition=2024 -D warnings --crate-name holder_evidence_protocol --crate-type rlib \
      worktree-holder-evidence-protocol-lib.rs -o "$out/lib/libholder_evidence_protocol.rlib"
    rustc --edition=2024 -D warnings --crate-name holder_evidence_codec \
      --extern holder_evidence_protocol="$out/lib/libholder_evidence_protocol.rlib" \
      worktree-holder-evidence-codec.rs -o "$out/bin/holder-evidence-codec"

    # Always exercise the real library/serializer through the linked executable.
    "$out/bin/holder-evidence-codec" > actual-codec-fixtures-v1.jsonl
    cmp ${fixture} actual-codec-fixtures-v1.jsonl
    cp actual-codec-fixtures-v1.jsonl "$out/share/holder-evidence-protocol/worktree-holder-evidence-v1.jsonl"
    cp ${
      lib.concatMapStringsSep " " lib.escapeShellArg sources
    } "$out/share/holder-evidence-protocol/src/"
  ''
