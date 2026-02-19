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

/** Self-hosted NixOS runner labels */
export const selfHostedRunner = ['self-hosted', 'nix'] as const

/** Standard devenv shell for CI job defaults */
export const devenvShellDefaults = {
  run: { shell: 'devenv shell bash -- -e {0}' },
} as const

/**
 * Standard CI environment variables.
 * GITHUB_TOKEN is exported for tools that need it as a shell env var (e.g. gh CLI, nix auth).
 * TODO: Drop DEVENV_TUI once devenv auto-disables TUI in CI (https://github.com/cachix/devenv/issues/2504)
 */
export const standardCIEnv = {
  FORCE_SETUP: '1',
  CI: 'true',
  DEVENV_TUI: 'false',
  GITHUB_TOKEN: '${{ github.token }}',
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
 * Includes devenv.cachix.org as extra substituter and github.com access-tokens
 * by default. On self-hosted where Nix is pre-installed, this action is a no-op
 * and extra-conf is silently skipped — the runner's nix wrapper handles
 * access-tokens there by reading GITHUB_TOKEN from the environment.
 */
export const installNixStep = (opts?: { extraConf?: string }) => ({
  name: 'Install Nix',
  uses: 'DeterminateSystems/determinate-nix-action@v3' as const,
  with: {
    'extra-conf': [
      'extra-substituters = https://devenv.cachix.org',
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
      'access-tokens = github.com=${{ github.token }}',
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
 * Skips installation if devenv is already on PATH (e.g. self-hosted runners).
 */
export const installDevenvFromLockStep = {
  name: 'Install devenv if needed',
  run: 'command -v devenv > /dev/null || nix profile install "github:cachix/devenv/$(jq -r .nodes.devenv.locked.rev devenv.lock)"',
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
 * Sync megarepo dependencies using the locked effect-utils rev from devenv.lock.
 * Resolves the rev inline and uses `nix run` to avoid `nix profile install`
 * (which can conflict on self-hosted).
 */
export const syncMegarepoFromLockStep = (opts?: { skip?: string[] }) => {
  const skipArgs = opts?.skip?.flatMap((s) => ['--skip', s]).join(' ') ?? ''
  return {
    name: 'Sync megarepo dependencies',
    run: `EU_REV=$(jq -r '.nodes["effect-utils"].locked.rev' devenv.lock)\nnix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- sync --frozen${skipArgs ? ` ${skipArgs}` : ''}`,
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
