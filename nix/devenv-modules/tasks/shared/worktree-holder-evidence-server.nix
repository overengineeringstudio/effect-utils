{
  pkgs,
  allowedRoots,
  ownerUid,
  managedPolicy ? null,
  withClients ? false,
  ownedVmClassDiagnostics ? false,
}:
let
  inherit (pkgs) lib;
  enabled = managedPolicy != null;
  managed = if enabled then managedPolicy else { };
  ipc = managed.ipc or { };
  policyId = builtins.hashString "sha256" (
    builtins.toJSON {
      inherit allowedRoots ownerUid managedPolicy;
    }
  );
  protocol = import ./worktree-holder-evidence-protocol.nix { inherit pkgs; };
  kernel = import ./worktree-holder-proc.nix { inherit pkgs ownedVmClassDiagnostics; };
  mounted = import ./worktree-holder-evidence-mounted.nix { inherit pkgs allowedRoots; };
  sources = map (suffix: "worktree-holder-evidence${suffix}.rs") (
    [
      "-server"
      "-server-auth"
      "-privileged-syscalls"
      "-server-decode"
      "-server-census"
      "-server-transport"
      "-server-host-ipc"
      "-listener"
      "-daemon"
      "-runtime"
    ]
    ++ lib.optionals withClients [
      "-cli-client"
      "-client-transport"
    ]
  );
  evidence =
    pkgs.runCommand (if ownedVmClassDiagnostics then "worktree-holder-evidence-server-owned-vm-diagnostics" else "worktree-holder-evidence-server")
      {
        nativeBuildInputs = [
          pkgs.rustc
          pkgs.stdenv.cc
        ];
        HOLDER_EVIDENCE_UID = toString ownerUid;
        HOLDER_EVIDENCE_PRODUCER_ID = builtins.placeholder "out";
        HOLDER_EVIDENCE_POLICY_ID = policyId;
        HOLDER_EVIDENCE_JQ = "${pkgs.jq}/bin/jq";
        HOLDER_EVIDENCE_SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
        HOLDER_EVIDENCE_MANAGED_ENABLED = if enabled then "1" else "0";
        HOLDER_EVIDENCE_MANAGED_CONTAINER = managed.container or "";
        HOLDER_EVIDENCE_MANAGED_IMAGE = managed.image or "";
        HOLDER_EVIDENCE_MANAGED_BINDS_JSON = builtins.toJSON (managed.binds or [ ]);
        HOLDER_EVIDENCE_MANAGED_UNIT = managed.unit or "";
        HOLDER_EVIDENCE_MANAGED_CGROUP = managed.cgroup or "";
        HOLDER_EVIDENCE_MANAGED_UNIT_SOURCE = toString (managed.unitSource or "");
        HOLDER_EVIDENCE_MANAGED_CURRENT_MANIFEST = toString (managed.currentManifest or "");
        HOLDER_EVIDENCE_MANAGED_DESIRED_MANIFEST = toString (managed.desiredManifest or "");
        HOLDER_EVIDENCE_IPC_RUNNER = toString (ipc.runner or "");
        HOLDER_EVIDENCE_IPC_BACKEND = toString (ipc.backend or "");
        HOLDER_EVIDENCE_IPC_PYTHON = toString (ipc.python or "");
        HOLDER_EVIDENCE_IPC_RUNNER_SOURCE = toString (ipc.runnerSource or "");
        HOLDER_EVIDENCE_IPC_RPC_SOURCE = toString (ipc.rpcSource or "");
        HOLDER_EVIDENCE_IPC_SSHD = toString (ipc.sshd or "");
        HOLDER_EVIDENCE_IPC_SSHD_CONFIG = toString (ipc.sshdConfig or "");
        HOLDER_EVIDENCE_IPC_AUTH_SOURCE = toString (ipc.authorizedKeysSource or "");
        HOLDER_EVIDENCE_IPC_AUTH_RUNTIME = ipc.authorizedKeysRuntime or "";
        HOLDER_EVIDENCE_IPC_UNIT = ipc.unit or "";
        HOLDER_EVIDENCE_IPC_CGROUP = ipc.cgroup or "";
        HOLDER_EVIDENCE_IPC_BACKEND_VARIABLE = ipc.backendVariable or "";
        HOLDER_EVIDENCE_IPC_ENVIRONMENT_LINE = ipc.environmentLine or "";
        HOLDER_EVIDENCE_IPC_RUNNER_DIGEST = ipc.runnerDigest or "";
        HOLDER_EVIDENCE_IPC_RPC_DIGEST = ipc.rpcDigest or "";
        passthru = {
          inherit
            allowedRoots
            ownerUid
            managedPolicy
            policyId
            ownedVmClassDiagnostics
            ;
        };
        meta = {
          description = "Inactive privileged fixed-policy holder evidence server";
          mainProgram = "worktree-holder-evidence";
          platforms = [
            "x86_64-linux"
            "aarch64-linux"
          ];
        };
      }
      ''
        ${lib.concatMapStringsSep "\n" (name: "cp ${./. + "/${name}"} ${lib.escapeShellArg name}") sources}
        externs=(
          --extern holder_evidence_protocol=${protocol}/lib/libholder_evidence_protocol.rlib
          --extern worktree_holder_proc=${kernel}/lib/libworktree_holder_proc.rlib
          --extern holder_evidence_mounted=${mounted}/lib/libholder_evidence_mounted.rlib
          -L dependency=${protocol}/lib
          -L dependency=${kernel}/lib
          -L dependency=${mounted}/lib
          ${lib.optionalString withClients "--cfg holder_evidence_clients"}
        )
        rustc --edition=2024 -D warnings "''${externs[@]}" --test worktree-holder-evidence-server.rs -o server-tests
        ./server-tests
        mkdir -p "$out/bin" "$out/share/holder-evidence-server/src"
        rustc --edition=2024 -D warnings -O -C panic=abort "''${externs[@]}" \
          worktree-holder-evidence-server.rs -o "$out/bin/worktree-holder-evidence"
        cp worktree-holder-evidence*.rs "$out/share/holder-evidence-server/src/"
      '';
in
assert builtins.isInt ownerUid && ownerUid > 0 && ownerUid <= 4294967295;
assert builtins.isList allowedRoots && builtins.all builtins.isString allowedRoots;
evidence
