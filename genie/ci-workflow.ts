/**
 * Shared CI workflow building blocks for GitHub Actions.
 *
 * Provides composable step atoms and job configuration helpers
 * that peer repos import to avoid CI template duplication.
 *
 * @example
 * ```ts
 * import {
 *   checkoutStep, installNixStep, cachixStep,
 *   installDevenvFromLockStep, devenvShellDefaults, standardCIEnv,
 * } from '../../repos/effect-utils/genie/ci-workflow.ts'
 *
 * const baseSteps = [
 *   checkoutStep(),
 *   installNixStep(),
 *   cachixStep({ name: 'my-cache' }),
 *   installDevenvFromLockStep,
 * ]
 * ```
 */

import { RUNNER_PROFILES, type RunnerProfile } from './ci.ts'

export { RUNNER_PROFILES, type RunnerProfile }

// =============================================================================
// Shared Config
// =============================================================================

/** Standard devenv shell for CI job defaults */
export const devenvShellDefaults = {
  run: { shell: 'devenv shell bash -- -e {0}' },
} as const

/** Standard CI environment variables */
export const standardCIEnv = {
  FORCE_SETUP: '1',
  CI: 'true',
} as const

/**
 * Namespace runner with run ID-based affinity to prevent queue jumping.
 * Adds a run ID label so runners spawned for one workflow run
 * don't steal jobs from other runs.
 */
export const namespaceRunner = (profile: RunnerProfile | (string & {}), runId: string) =>
  [profile, `namespace-features:github.run-id=${runId}`] as const

// =============================================================================
// Step Atoms
// =============================================================================

/** Checkout repository via actions/checkout@v4 */
export const checkoutStep = (opts?: { repository?: string; ref?: string; path?: string }) => ({
  uses: 'actions/checkout@v4' as const,
  ...(opts && Object.keys(opts).length > 0 ? { with: opts } : {}),
})

/**
 * Install Nix via DeterminateSystems/determinate-nix-action@v3.
 * Includes devenv.cachix.org as extra substituter by default
 * for pre-built devenv binaries.
 */
export const installNixStep = (opts?: { extraConf?: string }) => ({
  name: 'Install Nix',
  uses: 'DeterminateSystems/determinate-nix-action@v3' as const,
  with: {
    'extra-conf': [
      'extra-substituters = https://devenv.cachix.org',
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
      ...(opts?.extraConf ? [opts.extraConf] : []),
    ].join('\n'),
  },
})

/** Enable a Cachix binary cache */
export const cachixStep = (opts: { name: string; authToken?: string }) => ({
  name: 'Enable Cachix cache',
  uses: 'cachix/cachix-action@v16' as const,
  with: {
    name: opts.name,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
  },
})

/**
 * Install devenv pinned to the exact rev from devenv.lock.
 * Ensures version consistency between local dev and CI.
 */
export const installDevenvFromLockStep = {
  name: 'Install devenv',
  run: 'nix profile install github:cachix/devenv/$(jq -r ".nodes.devenv.locked.rev" devenv.lock)',
  shell: 'bash',
} as const

/** Install megarepo CLI from effect-utils */
export const installMegarepoStep = {
  name: 'Install megarepo CLI',
  run: 'nix profile install github:overengineeringstudio/effect-utils#megarepo',
  shell: 'bash',
} as const

/** Sync megarepo dependencies */
export const syncMegarepoStep = (opts?: { frozen?: boolean; skip?: string[] }) => {
  const args = ['mr', 'sync']
  if (opts?.frozen !== false) args.push('--frozen')
  if (opts?.skip) for (const s of opts.skip) args.push('--skip', s)
  return {
    name: 'Sync megarepo dependencies',
    run: args.join(' '),
    shell: 'bash',
  }
}

/**
 * Validate Nix store on namespace runners.
 * A cheap `devenv version` probe catches corruption before real work starts;
 * the expensive `--verify --repair` only runs when actually needed.
 * @see https://github.com/namespacelabs/nscloud-setup/issues/8
 * @see https://github.com/overengineeringstudio/effect-utils/issues/201
 */
export const validateNixStoreStep = {
  name: 'Validate Nix store',
  run: `if devenv version > /dev/null 2>&1; then
  echo "Nix store OK"
else
  echo "::warning::Nix store validation failed, running repair..."
  nix-store --verify --repair 2>&1 | tail -20
  devenv version
fi`,
  shell: 'bash',
} as const
