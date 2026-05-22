/**
 * Shared GitHub label catalog reused across primary megarepo members.
 *
 * Composed by each repo's `.github/labels.json.genie.ts`. Consumers spread the
 * relevant axes (`commonLabels`, `mqLabels`, `andonLabels`) and add their own
 * repo-local `area:*` labels.
 *
 * Source of truth for `mq:*` colors/descriptions: kept loosely aligned with
 * `flakes/merge-queue/crates/mq-core/src/gh_client.rs` in dotfiles, which is
 * the runtime safety net for lazy label creation. The reconciler is the
 * canonical writer once `dt gh:apply-labels` has run.
 */

import type { LabelDef, LegacyMigration } from '../packages/@overeng/genie/src/runtime/github-labels/mod.ts'

// ============================================================================
// Color palette (GitHub stores colors as 6-char hex without `#`)
// ============================================================================

const colors = {
  red: 'b60205',
  orange: 'd93f0b',
  yellow: 'fbca04',
  green: '0e8a16',
  brightGreen: '1f883d',
  blue: '0969da',
  brightBlue: '1d76db',
  lightBlue: '1f8fb8',
  purple: '5319e7',
  brightPurple: '8250df',
  lightPurple: 'a371f7',
  darkPurple: '6f42c1',
  pink: 'e99695',
  bugRed: 'd73a4a',
  docsBlue: '0075ca',
  grey: 'bfd4e2',
  lightGrey: 'ededed',
  pale: 'bfd4f2',
} as const

// ============================================================================
// type:* — what an issue/PR *is*
// ============================================================================

const typeLabels: readonly LabelDef[] = [
  { name: 'type:epic', color: colors.brightBlue, description: 'Large tracking issue with child tasks' },
  { name: 'type:rca', color: colors.purple, description: 'Root-cause analysis or investigation record' },
  { name: 'type:bug', color: colors.bugRed, description: 'Something broken or a regression' },
  { name: 'type:feature', color: colors.green, description: 'New user-visible or system capability' },
  { name: 'type:chore', color: colors.grey, description: 'Maintenance, cleanup, dependencies, CI, or refactoring' },
  {
    name: 'type:agent-tooling',
    color: colors.lightBlue,
    description: 'Agent, automation, AI workflow, or developer-agent tooling',
  },
  { name: 'type:docs', color: colors.docsBlue, description: 'Documentation-only change or documentation task' },
  { name: 'type:incident', color: colors.red, description: 'Live or recent operational incident' },
]

// ============================================================================
// state:* — lifecycle beyond open/closed
// ============================================================================

const stateLabels: readonly LabelDef[] = [
  { name: 'state:triage', color: colors.yellow, description: 'Needs classification or owner decision' },
  { name: 'state:blocked', color: colors.pink, description: 'Blocked on an external dependency or decision' },
]

// ============================================================================
// origin:* — who or what filed it
// ============================================================================

const originLabels: readonly LabelDef[] = [
  { name: 'origin:agent', color: colors.lightPurple, description: 'Filed or primarily produced by an AI agent' },
  { name: 'origin:janitor', color: colors.darkPurple, description: 'Filed by janitor automation' },
]

// ============================================================================
// area:* — lean shared baseline (truly cross-repo subsystems)
// ============================================================================

const sharedAreaLabels: readonly LabelDef[] = [
  { name: 'area:nix', color: colors.brightBlue, description: 'Nix flakes, derivations, FOD hashes, builders' },
  { name: 'area:typescript', color: colors.brightBlue, description: 'TypeScript code, tsconfig, and type definitions' },
  { name: 'area:ci', color: colors.brightBlue, description: 'CI workflows, runners, and pipeline configuration' },
  { name: 'area:storybook', color: colors.brightBlue, description: 'Storybook configuration and stories' },
  { name: 'area:effect', color: colors.brightBlue, description: 'Effect framework usage' },
  { name: 'area:devenv', color: colors.brightBlue, description: 'devenv tasks, inputs, and environment configuration' },
  { name: 'area:tooling', color: colors.brightBlue, description: 'Developer tooling, scripts, and utilities' },
]

// ============================================================================
// mq:* — Hypermerge / merge-queue lifecycle labels
//   Must stay loosely aligned with mq_label_color / mq_label_description in
//   dotfiles/flakes/merge-queue/crates/mq-core/src/gh_client.rs.
// ============================================================================

const mqStaticLabels: readonly LabelDef[] = [
  { name: 'mq:enrolled', color: colors.purple, description: 'PR is enrolled in Hypermerge' },
  {
    name: 'mq:merge-held',
    color: colors.pale,
    description: 'Hypermerge may prove this PR green but must not merge it',
  },
  {
    name: 'mq:blocked',
    color: colors.red,
    description: 'Hypermerge is not currently advancing this PR',
  },
  { name: 'mq:needs-agent', color: colors.orange, description: 'Hypermerge needs agentic intervention' },
  { name: 'mq:agent-active', color: colors.blue, description: 'Hypermerge has dispatched an agent' },
  { name: 'mq:needs-human', color: colors.brightPurple, description: 'Hypermerge needs human review' },
  {
    name: 'mq:ci-admitted',
    color: colors.brightGreen,
    description: 'Hypermerge admitted this PR to scarce-runner CI',
  },
  { name: 'mq:queue-head', color: colors.yellow, description: 'Current Hypermerge head for this repository' },
  { name: 'mq:status', color: colors.purple, description: 'Pinned Hypermerge status issue' },
]

/**
 * Canonical priority levels mirrored by Hypermerge. The runtime can create
 * additional `mq:priority-N` labels on demand (lazy `ensure_repo_label`); the
 * set below is what gets pre-created so triage UIs show consistent options.
 */
const mqPriorityLevels = [0, 1, 10, 20, 30, 100] as const

const mqPriorityLabels: readonly LabelDef[] = mqPriorityLevels.map((n) => ({
  name: `mq:priority-${n}`,
  color: colors.green,
  description: 'Hypermerge priority mirror',
}))

// ============================================================================
// andon:* — cross-machine incident states (see /sk-andon)
// ============================================================================

const andonStateLabels: readonly LabelDef[] = [
  { name: 'andon:firing', color: colors.red, description: 'Andon: actively impacting development right now' },
  { name: 'andon:degraded', color: colors.orange, description: 'Andon: partial impact / workaround available' },
  { name: 'andon:watching', color: colors.yellow, description: 'Andon: known concern, not yet impacting' },
  { name: 'andon:claimed', color: colors.green, description: 'Andon: someone is actively triaging' },
]

// ============================================================================
// Public exports
// ============================================================================

/**
 * Cross-cutting label axes present in every primary megarepo member:
 * `type:*`, `state:*`, `origin:*`, plus a lean baseline of shared `area:*`.
 *
 * Repo-specific `area:*` labels are added per-repo by spreading additional
 * `LabelDef` literals into the `labels` array.
 */
export const commonLabels: readonly LabelDef[] = [
  ...typeLabels,
  ...stateLabels,
  ...originLabels,
  ...sharedAreaLabels,
]

/** Hypermerge merge-queue labels including the canonical priority levels. */
export const mqLabels: readonly LabelDef[] = [...mqStaticLabels, ...mqPriorityLabels]

/** Andon cross-machine incident state labels. */
export const andonLabels: readonly LabelDef[] = andonStateLabels

/**
 * GitHub's bare default labels superseded by the `type:*` axis. Listed here
 * so each repo can declare them deprecated without copy-pasting.
 *
 * Note: `good first issue` / `help wanted` are deliberately *not* included —
 * keep them in public repos.
 */
export const deprecatedDefaults: readonly string[] = [
  'bug',
  'documentation',
  'duplicate',
  'enhancement',
  'invalid',
  'question',
  'wontfix',
]

/**
 * Canonical migrations applied by `mq-cli repo labels migrate` before the
 * legacy labels are deleted. Idempotent: missing labels are no-ops.
 */
export const legacyMigrations: readonly LegacyMigration[] = [
  { from: 'bug', to: 'type:bug' },
  { from: 'enhancement', to: 'type:feature' },
  { from: 'documentation', to: 'type:docs' },
]
