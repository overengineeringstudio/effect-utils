# Reproducible root-only kernel qualification inside a disposable NixOS VM.
# No production service, host privilege or enrolled candidate is involved.
{ pkgs }:
let
  proc = import ./worktree-holder-proc.nix { inherit pkgs; };
in
pkgs.testers.nixosTest {
  name = "worktree-holder-thread-fd-alias";
  nodes.machine = {
    environment.systemPackages = [ proc ];
    virtualisation.memorySize = 1024;
  };
  testScript = ''
    start_all()
    machine.wait_for_unit("multi-user.target")
    # Retain actual guest facts; do not infer capabilities or pidfd support from
    # the host or silently select another kernel when the fixture refuses.
    print(machine.succeed("uname -r; id; grep '^CapEff:' /proc/self/status"))
    output = machine.succeed("${proc}/libexec/worktree-holder-proc-tests --ignored --exact linux::alias_tests::actual_worker_shared_unshared_and_reopened_descriptions --nocapture")
    print(output)
    assert "1 passed; 0 failed" in output, "the actual ignored kernel fixture must execute"
  '';
}
