# Pure evaluation assertions: no app assembly, code signing or permission APIs.
{ pkgs, nixpkgsRevision }:
let
  policy = {
    uid = 501;
    socket = "/var/empty/permissions-host/rpc/socket";
    audit = "/var/empty/permissions-host/audit.jsonl";
    staging = "/var/empty/permissions-host/staging";
    policyRevision = "identity-fixture";
    releaseRevision = "identity-fixture";
    documents = {
      sources = { };
      maxItems = 1;
      maxBytes = 1;
      timeoutMs = 1000;
    };
    products = { };
    auditMaxBytes = 1048576;
    notificationMinIntervalMs = 1000;
  };
  make = values: grants: import ./default.nix { inherit pkgs nixpkgsRevision; } {
    bundleId = "org.example.permissions-host";
    displayName = "Mac Permissions Host";
    signer = { teamId = "EXAMPLETEAM"; identity = "Developer ID Application: Example"; };
    policyFiles = [ (builtins.toFile "permissions-host-identity-policy.json" (builtins.toJSON values)) ];
    enabledGrants = grants;
  };
  before = make policy [ "notifications" ];
  changedPolicy = make (policy // { notificationMinIntervalMs = 2000; }) [ "notifications" ];
  changedEntitlements = make policy [ "notifications" "microphone" ];
  comparedIdentity = app: app.infoPlistData.MacPermissionsHostPolicyHash;
in
assert before.hostSourceHash == changedPolicy.hostSourceHash;
assert comparedIdentity before != comparedIdentity changedPolicy;
assert comparedIdentity before != comparedIdentity changedEntitlements;
{
  policyOnlyChangesComparedIdentity = true;
  entitlementPolicyChangesComparedIdentity = true;
  policyOnlyPreservesCompiledSourceHash = true;
}
