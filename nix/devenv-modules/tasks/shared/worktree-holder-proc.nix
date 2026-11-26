# Inactive library and VM regression runner only: no socket, unit or service export.
{ pkgs }:
let
  sources = map (suffix: "worktree-holder-proc${suffix}.rs") [
    ""
    "-linux"
    "-objects"
    "-process"
    "-scopes"
    "-tests"
  ];
in
pkgs.runCommand "worktree-holder-proc"
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    meta = {
      description = "Read-only Linux proc generation, task and resource census primitives";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  }
  ''
    ${pkgs.lib.concatMapStringsSep "\n" (
      name: "cp ${./. + "/${name}"} ${pkgs.lib.escapeShellArg name}"
    ) sources}
    rustc --edition=2024 -D warnings --test worktree-holder-proc.rs -o proc-tests
    ./proc-tests
    mkdir -p "$out/lib" "$out/libexec" "$out/share/worktree-holder-proc"
    rustc --edition=2024 -D warnings --crate-name worktree_holder_proc --crate-type rlib worktree-holder-proc.rs -o "$out/lib/libworktree_holder_proc.rlib"
    cp worktree-holder-proc*.rs "$out/share/worktree-holder-proc/"
    cp proc-tests "$out/libexec/worktree-holder-proc-tests"
  ''
