{
  pkgs,
  allowedRoots,
  ownerUid,
  managedPolicy ? null,
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
  rootsSource = pkgs.writeText "worktree-holder-evidence-roots.rs" ''
    const ALLOWED_ROOTS: &[&str] = &${builtins.toJSON allowedRoots};
  '';
  sources = map (suffix: "worktree-holder-evidence${suffix}.rs") [
    ""
    "-request"
    "-linux"
    "-objects"
    "-client"
    "-mounts"
    "-listener"
    "-decode"
    "-daemon"
    "-host-ipc"
    "-runtime"
    "-census"
    "-candidates"
    "-protocol"
    "-transport"
  ];
  adapter = pkgs.writeShellScriptBin "pnpm-store-evidence" ''
    exec ${evidence}/bin/worktree-holder-evidence --pnpm-client-v1 "$@"
  '';
  evidence =
    pkgs.runCommand "worktree-holder-evidence"
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
          inherit allowedRoots ownerUid managedPolicy;
          processEvidenceCommand = adapter;
          holderEvidenceClient = {
            path = "${evidence}/bin/worktree-holder-evidence";
            producerId = "${evidence}";
            inherit policyId;
          };
        };
        meta = {
          description = "Fixed-policy read-only all-UID holder evidence for native worktrees and pnpm stores";
          mainProgram = "worktree-holder-evidence";
          platforms = [
            "x86_64-linux"
            "aarch64-linux"
          ];
        };
      }
      ''
        ${lib.concatMapStringsSep "\n" (name: "cp ${./. + "/${name}"} ${lib.escapeShellArg name}") sources}
        cp ${rootsSource} worktree-holder-evidence-roots.rs
        rustc --edition=2024 -D warnings --test worktree-holder-evidence.rs -o evidence-tests
        ./evidence-tests
        mkdir -p "$out/bin"
        rustc --edition=2024 -D warnings -O -C panic=abort worktree-holder-evidence.rs -o "$out/bin/worktree-holder-evidence"
        "$out/bin/worktree-holder-evidence" --codec-fixtures-v1 > actual-codec-fixtures-v1.jsonl
        cmp ${../../../../. + "/packages/@overeng/megarepo/src/store/fixtures/worktree-holder-evidence-v1.jsonl"} actual-codec-fixtures-v1.jsonl
      '';
in
assert builtins.isInt ownerUid && ownerUid > 0 && ownerUid <= 4294967295;
assert builtins.isList allowedRoots && builtins.all builtins.isString allowedRoots;
evidence
