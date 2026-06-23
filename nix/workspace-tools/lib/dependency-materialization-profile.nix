{ lib }:

let
  sortedStrings = values: builtins.sort (left: right: left < right) values;

  sortedAttrs =
    attrs:
    builtins.listToAttrs (
      map (name: {
        inherit name;
        value = builtins.getAttr name attrs;
      }) (sortedStrings (builtins.attrNames attrs))
    );

  withoutContext = value: builtins.unsafeDiscardStringContext (builtins.toJSON value);

  profileKeyFor = identity: builtins.hashString "sha256" (withoutContext identity);

  defaultPolicy = {
    packageManager = "pnpm";
    lockfileMode = "frozen";
    lifecycleScripts = "ignored";
    optionalDependencies = "excluded";
    globalVirtualStore = "disabled-in-nix-prep";
    liveStoreState = "purged-from-output";
  };
in
{
  mkPreparedDepsProfile =
    {
      installDir,
      memberDirs,
      lockfilePath,
      attrName,
      depsHash,
      manifestInputs,
      freshnessInputs ? { },
      policy ? { },
      traits ? [ ],
    }:
    let
      identity = {
        inherit installDir lockfilePath;
        memberDirs = sortedStrings memberDirs;
        policy = sortedAttrs (defaultPolicy // policy);
        freshness = sortedAttrs freshnessInputs;
      };
    in
    {
      schemaVersion = 1;
      kind = "dependency-materialization-profile";
      inherit attrName depsHash identity;
      profileKey = profileKeyFor identity;
      traits = sortedStrings ([ "nixPreparedDeps" ] ++ traits);
      inputs = {
        manifests = sortedStrings manifestInputs;
      };
      freshness = freshnessInputs;
    };

  mkEvidence =
    {
      packageName,
      packageDir,
      profiles,
    }:
    {
      schemaVersion = 1;
      kind = "dependency-materialization-evidence";
      producer = "effect-utils.mk-pnpm-cli";
      subject = {
        inherit packageName packageDir;
      };
      profiles = map (
        profile:
        profile
        // {
          evidenceKey = profileKeyFor {
            inherit (profile)
              kind
              profileKey
              depsHash
              traits
              ;
          };
        }
      ) profiles;
    };

  mkBuck2Evidence =
    {
      packageName,
      packageDir,
      evidence,
    }:
    {
      schemaVersion = 1;
      kind = "buck2-dependency-materialization-evidence";
      producer = "effect-utils.mk-pnpm-cli";
      subject = {
        inherit packageName packageDir;
      };
      materializations = map (profile: {
        inherit (profile)
          attrName
          depsHash
          evidenceKey
          freshness
          inputs
          profileKey
          traits
          ;
        inherit (profile.identity) installDir lockfilePath memberDirs;
        owner = "nix-prepared-deps";
        ownsLiveMaterialization = false;
        repairAuthority = "devenv-pnpm-tasks";
      }) evidence.profiles;
    };
}
