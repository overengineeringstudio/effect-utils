/**
 * Shared CI configuration for genie files.
 * Single source of truth for CI job names used in both:
 * - .github/workflows/ci.yml.genie.ts (job definitions)
 * - .github/repo-settings.json.genie.ts (required status checks)
 */

/** CI job names that must pass before merging */
export const requiredCIJobs = ['typecheck', 'lint', 'test', 'nix-check'] as const

export type CIJobName = (typeof requiredCIJobs)[number]
