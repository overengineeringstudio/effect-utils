# Same immutable binary for socket server and both strict unprivileged clients.
# Importing this constructor does not install a socket, unit or cleanup action.
{
  pkgs,
  allowedRoots,
  ownerUid,
  managedPolicy ? null,
}:
let
  server = import ./worktree-holder-evidence-server.nix {
    inherit
      pkgs
      allowedRoots
      ownerUid
      managedPolicy
      ;
    withClients = true;
  };
  adapter = pkgs.writeShellScriptBin "pnpm-store-evidence" ''
    exec ${evidence}/bin/worktree-holder-evidence --pnpm-client-v1 "$@"
  '';
  evidence = server.overrideAttrs (old: {
    name = "worktree-holder-evidence";
    passthru = (old.passthru or { }) // {
      processEvidenceCommand = adapter;
      holderEvidenceClient = {
        path = "${evidence}/bin/worktree-holder-evidence";
        producerId = "${evidence}";
        policyId = server.policyId;
      };
    };
    meta = old.meta // {
      description = "Fixed-policy read-only holder server and same-binary strict clients";
    };
  });
in
evidence
