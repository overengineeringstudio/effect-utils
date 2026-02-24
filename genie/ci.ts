/**
 * Shared CI configuration for genie files.
 * Single source of truth for CI job names used in both:
 * - .github/workflows/ci.yml.genie.ts (job definitions)
 * - .github/repo-settings.json.genie.ts (required status checks)
 */

/** Runner profiles for multi-platform CI jobs */
export const RUNNER_PROFILES = [
  'namespace-profile-linux-x86-64',
  'namespace-profile-macos-arm64',
] as const
export type RunnerProfile = (typeof RUNNER_PROFILES)[number]

/** CI job names (keys in the workflow jobs object) */
export const CI_JOB_NAMES = ['typecheck', 'lint', 'test', 'nix-check'] as const
export type CIJobName = (typeof CI_JOB_NAMES)[number]

/**
 * Required status checks for branch protection.
 * Matrix jobs are reported as "job-name (matrix-value)" by GitHub Actions.
 */
export const requiredCIJobs = [
  'typecheck',
  'lint',
  // Matrix jobs - GitHub reports these with the matrix value in parentheses
  ...RUNNER_PROFILES.map((runner) => `test (${runner})`),
  ...RUNNER_PROFILES.map((runner) => `nix-check (${runner})`),
  'deploy-storybooks',
] as const
