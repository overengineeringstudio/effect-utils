# Inactive library and test runner only: no adapter, socket, unit or service.
# The explicit diagnostic variant is only for a controlled, disposable VM.
{ pkgs, ownedVmClassDiagnostics ? false }:
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
pkgs.runCommand (if ownedVmClassDiagnostics then "worktree-holder-proc-owned-vm-diagnostics" else "worktree-holder-proc")
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
    rustc --edition=2024 -D warnings --check-cfg 'cfg(test)' --check-cfg 'cfg(holder_owned_vm_class_diagnostics)' ${pkgs.lib.optionalString ownedVmClassDiagnostics "--cfg holder_owned_vm_class_diagnostics"} --test worktree-holder-proc.rs -o proc-tests
    ./proc-tests
    mkdir -p "$out/lib" "$out/libexec" "$out/share/worktree-holder-proc"
    rustc --edition=2024 -D warnings --check-cfg 'cfg(test)' --check-cfg 'cfg(holder_owned_vm_class_diagnostics)' ${pkgs.lib.optionalString ownedVmClassDiagnostics "--cfg holder_owned_vm_class_diagnostics"} --crate-name worktree_holder_proc --crate-type rlib worktree-holder-proc.rs -o "$out/lib/libworktree_holder_proc.rlib"
    cp worktree-holder-proc*.rs "$out/share/worktree-holder-proc/"
    cp proc-tests "$out/libexec/worktree-holder-proc-tests"
  ''
