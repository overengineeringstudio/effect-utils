# Disposable integration only: actual Bun workers, authenticated fixed socket,
# strict TypeScript codec/source and owned-pin deletion engine. No host rollout.
{
  pkgs,
  mkBuckProductFromSource,
  pnpmArchives,
  capabilities,
  producerCommit,
}:
let
  evidence = import ./worktree-holder-evidence.nix {
    inherit pkgs;
    ownerUid = 1000;
    allowedRoots = [ "/var/lib/holder-fixture" ];
    managedPolicy = null;
    ownedVmClassDiagnostics = true;
  };
  client = evidence.holderEvidenceClient;
  proc = import ./worktree-holder-proc.nix { inherit pkgs; };
  # Reuse the canonical immutable source projection and pinned dependency view.
  # These test-only Buck rules exist solely in the derivation, not the product
  # registry or generated checkout BUCK. Both bundles use the real local source.
  recipe = mode: {
    inherit pnpmArchives capabilities producerCommit;
    product = {
      name = "worktree-holder-node-${mode}";
      kind = "fixture";
      target = "//packages/@overeng/megarepo:holder_vm_${mode}";
      outputName = "${mode}.js";
    };
  };
  baseSource = (mkBuckProductFromSource (recipe "consumer")).source;
  fixtureRules = pkgs.writeText "holder-node-vm.buck" ''
    package_view(
        name = "holder_vm_tree",
        dependency_view = "//buck2/dependencies:view_packages_overeng_megarepo_b89b4c18f380",
        files = {path: path for path in glob(["src/**/*.ts", "package.json"])},
        runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",
        runtime_entry = "package-tree.ts",
        visibility = ["PUBLIC"],
    )
    ${pkgs.lib.concatMapStringsSep "\n" (mode: ''
      package_bin_artifact(
          name = "holder_vm_${mode}",
          entrypoint = "src/store/fixtures/worktree-holder-node-${mode}.ts",
          external = [],
          external_capabilities = [],
          kind = "cli",
          output = "${mode}.js",
          package_tree = ":holder_vm_tree",
          target = "bun",
          visibility = ["PUBLIC"],
      )
    '') [ "consumer" "worker" ]}
  '';
  source = pkgs.runCommand "holder-node-vm-source" { } ''
    cp -R ${baseSource} "$out"
    chmod u+w "$out/packages/@overeng/megarepo/BUCK"
    cat ${fixtureRules} >> "$out/packages/@overeng/megarepo/BUCK"
  '';
  bundle = mode: mkBuckProductFromSource ((recipe mode) // { repositorySource = source; });
  consumer = bundle "consumer";
  worker = bundle "worker";
in
assert evidence.ownedVmClassDiagnostics;
pkgs.testers.nixosTest {
  name = "worktree-holder-node-consumer";
  nodes.machine = {
    users.users.fixture = {
      isNormalUser = true;
      uid = 1000;
      group = "users";
    };
    systemd.tmpfiles.rules = [ "d /var/lib/holder-fixture 0700 fixture users -" ];
    environment.systemPackages = [ pkgs.bun pkgs.util-linux evidence ];
    virtualisation.memorySize = 2048;
    boot.kernel.sysctl."kernel.io_uring_disabled" = 0;
    systemd.sockets.worktree-holder-evidence = {
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/worktree-holder-evidence/evidence.sock";
        SocketUser = "root";
        SocketGroup = "users";
        SocketMode = "0660";
        DirectoryMode = "0755";
        Accept = true;
        MaxConnections = 1;
        Backlog = 16;
        RemoveOnStop = true;
      };
    };
    systemd.services."worktree-holder-evidence@".serviceConfig = {
      ExecStart = "${client.path} --serve-once";
      User = "root";
      Group = "root";
      WorkingDirectory = "/";
      StandardInput = "socket";
      StandardOutput = "socket";
      StandardError = "journal";
      RuntimeMaxSec = 30;
      TimeoutStopSec = 2;
      KillMode = "control-group";
      MemoryMax = "512M";
      TasksMax = 16;
      LimitNOFILE = 131072;
      UMask = "0077";
      NoNewPrivileges = true;
      RestrictNamespaces = true;
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      RestrictAddressFamilies = [ "AF_UNIX" ];
      # Authentication requires the guest's initial USER/PID/MNT/NET namespaces.
      PrivateMounts = false;
      PrivateTmp = false;
      PrivateUsers = false;
      PrivateNetwork = false;
      PrivateDevices = false;
      ProtectSystem = false;
      ProtectHome = false;
      ProtectProc = "default";
      ProcSubset = "all";
      CapabilityBoundingSet = [
        "CAP_DAC_READ_SEARCH"
        "CAP_SYS_PTRACE"
        "CAP_CHECKPOINT_RESTORE"
        "CAP_NET_ADMIN"
      ];
      SystemCallFilter = [ "~@mount" "@reboot" "@swap" "@module" "@raw-io" "setns" "unshare" ];
    };
  };
  testScript = ''
    import json
    import shlex

    start_all()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("worktree-holder-evidence.socket")
    print(machine.succeed("uname -a; id; grep '^Cap' /proc/self/status; readlink /proc/1/ns/*"))
    machine.succeed("test $(stat -c '%u:%g:%a' /run/worktree-holder-evidence) = 0:0:755")
    machine.succeed("test $(stat -c '%U:%G:%a' /run/worktree-holder-evidence/evidence.sock) = root:users:660")
    machine.succeed("test $(stat -c '%u:%a' /var/lib/holder-fixture) = 1000:700")
    btf = machine.succeed("${proc}/libexec/worktree-holder-proc-tests --exact tests::actual_loaded_btf_is_nonpath --ignored --nocapture")
    print(btf)
    assert "1 passed; 0 failed" in btf, "the actual BTF_LOAD metadata fixture must execute"
    nonpath = machine.succeed("${proc}/libexec/worktree-holder-proc-tests --exact tests::actual_nonpath_eventfd_and_registered_io_uring_veto --ignored --nocapture")
    print(nonpath)
    assert "1 passed; 0 failed" in nonpath, "the real eventfd and registered-file io_uring fixture must execute"
    aliases = machine.succeed("${proc}/libexec/worktree-holder-proc-tests --exact linux::alias_tests::actual_worker_shared_unshared_and_reopened_descriptions --ignored --nocapture")
    print(aliases)
    assert "1 passed; 0 failed" in aliases, "the real kernel alias fixture must execute"
    try:
        for mode in ["shared", "unshared", "different-fd"]:
            root = "/var/lib/holder-fixture/" + mode
            machine.succeed("test ! -e " + shlex.quote(root))
            argv = [
                "${pkgs.bun}/bin/bun", "${consumer}/consumer.js",
                "--client", "${client.path}",
                "--producer-id", "${client.producerId}",
                "--policy-id", "${client.policyId}",
                "--root", root, "--mode", mode,
                "--worker", "${worker}/worker.js",
            ]
            command = "cd /home/fixture && exec " + shlex.join(argv)
            output = machine.succeed("runuser -u fixture -- sh -c " + shlex.quote(command), timeout=120)
            print(output)
            receipt = json.loads(output)
            assert receipt["mode"] == mode and receipt["root"] == root, receipt
            assert receipt["observation"]["complete"] is True, receipt
            assert receipt["observation"]["inUse"]["_tag"] == ("free" if mode == "shared" else "in-use"), receipt
            assert receipt["removed"] is (mode == "shared"), receipt
            refs = [ref for ref in receipt["evidence"]["root"]["references"]
                    if ref["tid"] == receipt["worker"]["tid"] and ref["tgid"] != ref["tid"] and ref["reference"] == "fd"]
            assert refs, receipt
            assert receipt["evidence"]["producerId"] == "${client.producerId}", receipt
            assert receipt["evidence"]["policyId"] == "${client.policyId}", receipt
            assert receipt["worker"]["unshared"] is (mode == "unshared"), receipt
            if mode == "shared":
                for ref in refs:
                    alias = ref["leaderFdAlias"]
                    assert alias["proof"] == "pidfd-kcmp-files-and-file-v1", receipt
                    assert any(pin["pid"] == ref["tgid"] and pin["fd"] == ref["fd"] and
                               pin["dev"] == ref["identity"]["dev"] and pin["ino"] == ref["identity"]["ino"]
                               for pin in receipt["pins"]), receipt
            elif mode == "unshared":
                assert all("leaderFdAlias" not in ref for ref in refs), receipt
            if mode == "shared":
                machine.succeed("test ! -e " + shlex.quote(root))
            else:
                machine.succeed("test -d " + shlex.quote(root) + " && test $(stat -c %u " + shlex.quote(root) + ") = 1000")
                identity = receipt["evidence"]["root"]["identity"]
                assert machine.succeed("stat -c '%d:%i' " + shlex.quote(root)).strip() == identity["dev"] + ":" + identity["ino"], receipt
                assert machine.succeed("cat " + shlex.quote(root + "/payload")) == "disposable holder integration payload\n"
    finally:
        print(machine.execute("journalctl --no-pager -b -u 'worktree-holder-evidence*' -o short-precise")[1])
        print(machine.execute("uname -a; grep '^Cap' /proc/self/status; cat /proc/sys/kernel/yama/ptrace_scope; systemctl show 'worktree-holder-evidence@*' -p CapabilityBoundingSet -p Result")[1])
  '';
}
