{ lib }:

rec {
  # Live devenv installs and fixed-output dependency preparation should agree
  # on the resource-sensitive pnpm knobs. Keep this list small: these flags
  # define install purity and Darwin pressure limits, while callers still own
  # their lockfile mode and store path.
  liveInstallPolicyFlags = [
    "--config.confirmModulesPurge=false"
    "--config.side-effects-cache=false"
    "--config.verify-store-integrity=true"
    "--config.strict-store-pkg-content-check=true"
    "--child-concurrency=1"
    "--network-concurrency=4"
    "--config.package-import-method=clone-or-copy"
    "--pm-on-fail=ignore"
  ];

  # The fixed-output builder writes policy through .npmrc because pnpm 11
  # rejects some workspace-scoped keys via `pnpm config set --global`. The
  # prepared tree is restored directly by downstream builds, so we force an
  # isolated virtual store and disable settings that would preserve caller-local
  # mutable store state in the fixed-output artifact.
  workspacePrepNpmrcLines = packageImportMethod: [
    "virtual-store-dir=node_modules/.pnpm"
    "package-import-method=${packageImportMethod}"
    "side-effects-cache=false"
    "verify-store-integrity=true"
    "strict-store-pkg-content-check=true"
    "enable-global-virtual-store=false"
    "pm-on-fail=ignore"
    "verify-deps-before-run=false"
    "node-linker=isolated"
    "child-concurrency=1"
    "network-concurrency=4"
  ];

  workspacePrepNpmrc =
    packageImportMethod:
    lib.concatMapStrings (line: "${line}\n") (workspacePrepNpmrcLines packageImportMethod);

  # Before appending builder-local policy, strip equivalent user/workspace
  # settings. Otherwise absolute store paths or different linker settings can
  # leak from the source workspace into what should be a reusable prepared tree.
  npmrcPolicyKeys = [
    "store-dir"
    "virtual-store-dir"
    "enable-global-virtual-store"
    "global-virtual-store-dir"
    "state-dir"
    "cache-dir"
    "package-import-method"
    "node-linker"
    "side-effects-cache"
    "side-effects-cache-readonly"
    "verify-store-integrity"
    "strict-store-pkg-content-check"
    "pm-on-fail"
    "verify-deps-before-run"
    "child-concurrency"
    "network-concurrency"
  ];

  # pnpm-workspace.yaml uses camelCase for the same policy surface that .npmrc
  # spells in kebab-case. Keep the scrub list beside npmrcPolicyKeys so adding
  # a new shared install knob updates both source surfaces together.
  workspaceYamlPolicyKeys = [
    "storeDir"
    "virtualStoreDir"
    "enableGlobalVirtualStore"
    "globalVirtualStoreDir"
    "stateDir"
    "cacheDir"
    "packageImportMethod"
    "nodeLinker"
    "optimisticRepeatInstall"
    "verifyDepsBeforeRun"
    "sideEffectsCache"
    "sideEffectsCacheReadonly"
    "verifyStoreIntegrity"
    "strictStorePkgContentCheck"
    "pmOnFail"
    "childConcurrency"
    "networkConcurrency"
  ];

  # On Darwin, whole-workspace materialization can push pnpm's Node process into
  # kernel/libuv teardown failures after the install has already produced the
  # usable node_modules tree. The heap cap lowers that pressure without changing
  # the dependency artifact contract.
  darwinNodeOptionsShell = ''
    export NODE_OPTIONS="''${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536"
  '';

  # Accept only the Darwin teardown failures we have observed after pnpm proves
  # materialization finished. Exit 137 is SIGKILL; exit 134 is libuv's abort path
  # (`uv__io_poll` assertion). The node_modules checks keep genuine failed or
  # partial installs on the normal error path.
  darwinCompletedMaterializationCheckShell =
    {
      statusVar,
      logFileVar,
      isDarwinShell ? "1",
    }:
    let
      statusRef = "$" + statusVar;
      logFileRef = "$" + logFileVar;
    in
    ''{ [ "${statusRef}" -eq 137 ] || [ "${statusRef}" -eq 134 ]; } && [ ${isDarwinShell} = "1" ] && grep -qE 'Progress: .* done$' "${logFileRef}" && [ -d node_modules/.pnpm ] && [ -f node_modules/.modules.yaml ]'';
}
