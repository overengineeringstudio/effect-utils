# Inactive native-membership library; no server, socket, adapter or service.
{
  pkgs,
  allowedRoots ? [ ],
  ownedVmClassDiagnostics ? false,
}:
let
  inherit (pkgs) lib;
  protocol = import ./worktree-holder-evidence-protocol.nix { inherit pkgs; };
  kernel = import ./worktree-holder-proc.nix { inherit pkgs ownedVmClassDiagnostics; };
  sources = map (suffix: "worktree-holder-evidence${suffix}.rs") [
    "-mounted-lib"
    "-inventory"
    "-mounts"
    "-candidates"
  ];
  roots = pkgs.writeText "holder-evidence-roots.rs" (
    "const ALLOWED_ROOTS: &[&str] = &["
    + lib.concatMapStringsSep "," builtins.toJSON allowedRoots
    + "];\n"
  );
in
assert builtins.isList allowedRoots && builtins.all builtins.isString allowedRoots;
pkgs.runCommand (if ownedVmClassDiagnostics then "holder-evidence-native-membership-owned-vm-diagnostics" else "holder-evidence-native-membership")
  {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
    meta = {
      description = "Inactive native task mount views and candidate membership census";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  }
  ''
    ${lib.concatMapStringsSep "\n" (name: "cp ${./. + "/${name}"} ${lib.escapeShellArg name}") sources}
    cp ${roots} worktree-holder-evidence-roots.rs
    externs=(
      --extern holder_evidence_protocol=${protocol}/lib/libholder_evidence_protocol.rlib
      --extern worktree_holder_proc=${kernel}/lib/libworktree_holder_proc.rlib
    )
    rustc --edition=2024 -D warnings "''${externs[@]}" --test worktree-holder-evidence-mounted-lib.rs -o mounted-tests
    ./mounted-tests
    mkdir -p "$out/lib" "$out/share/holder-evidence-mounted/src"
    rustc --edition=2024 -D warnings "''${externs[@]}" --crate-name holder_evidence_mounted --crate-type rlib \
      worktree-holder-evidence-mounted-lib.rs -o "$out/lib/libholder_evidence_mounted.rlib"
    cp worktree-holder-evidence*.rs "$out/share/holder-evidence-mounted/src/"
  ''
