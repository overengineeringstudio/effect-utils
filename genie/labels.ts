/**
 * Shared GitHub label catalog reused across primary megarepo members.
 *
 * Composed by each repo's `.github/labels.json.genie.ts`. Consumers spread the
 * relevant axes (`commonLabels`, `andonLabels`) and add their own repo-local
 * `area:*`/`system:*` labels (see `deriveSystemLabels` in `./system-labels.ts`).
 *
 * The merge-queue `mq:*` axis is retired (see `mqDeprecated` below); Hypermerge's
 * `hy:*` labels live in dotfiles' hypermerge flake (only enrolled repo). The
 * `devenv tasks run gh:apply-labels` task is the canonical writer;
 * `devenv tasks run gh:check-labels` reports drift without applying.
 *
 * Every description includes a trailing `· Set: <who>` clause naming the
 * party responsible for applying the label (manual, Hypermerge daemon,
 * janitor-cli, andon CLI, or AI agent).
 */

import type {
  LabelDef,
  LegacyMigration,
} from '../packages/@overeng/genie/src/runtime/github-labels/mod.ts'

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
  /* Distinct light blue for `type:refactor` so it reads apart from the grey `type:chore` chip. */
  iceBlue: 'c5def5',
  /* Pale lavender-grey for `type:task`, distinct from `type:chore` grey and `type:refactor` iceBlue. */
  dust: 'cdc5e2',
  /* Neutral slate used as the single, axis-consistent color for all `state:*` labels. */
  slate: '6e7781',
} as const

// ============================================================================
// type:* — what an issue/PR *is*
// ============================================================================

const typeLabels: readonly LabelDef[] = [
  {
    // brightPurple (not brightBlue) so an epic chip is distinct from every `area:*` chip.
    name: 'type:epic',
    color: colors.brightPurple,
    description: 'Large tracking issue with child tasks · Set: manual',
  },
  {
    name: 'type:rca',
    color: colors.purple,
    description: 'Root-cause analysis or investigation record · Set: manual',
  },
  {
    name: 'type:bug',
    color: colors.bugRed,
    description: 'Something broken or a regression · Set: manual',
  },
  {
    name: 'type:feature',
    color: colors.green,
    description: 'New user-visible or system capability · Set: manual',
  },
  {
    name: 'type:chore',
    color: colors.grey,
    description: 'Maintenance, cleanup, dependencies, or CI · Set: manual',
  },
  {
    // Behavior-preserving restructuring — a distinct kind of work from `type:chore`
    // (deps/CI/tooling). Boundary: if runtime behavior is intentionally unchanged, it's refactor.
    name: 'type:refactor',
    color: colors.iceBlue,
    description: 'Behavior-preserving code restructuring · Set: manual',
  },
  {
    name: 'type:task',
    color: colors.dust,
    description:
      'Scoped implementation/follow-up work (not bug/feature/docs/incident/RCA/epic) · Set: manual',
  },
  {
    name: 'type:agent-tooling',
    color: colors.lightBlue,
    description: 'Agent, automation, AI workflow, or developer-agent tooling · Set: manual',
  },
  {
    name: 'type:docs',
    color: colors.docsBlue,
    description: 'Documentation-only change or documentation task · Set: manual',
  },
  {
    name: 'type:incident',
    color: colors.red,
    description: 'Live or recent operational incident · Set: manual or andon CLI',
  },
]

// ============================================================================
// state:* — lifecycle beyond open/closed
// ============================================================================

const stateLabels: readonly LabelDef[] = [
  {
    name: 'state:triage',
    color: colors.slate,
    description: 'Needs classification or owner decision · Set: manual',
  },
  {
    name: 'state:blocked',
    color: colors.slate,
    description: 'Blocked on an external dependency or decision · Set: manual',
  },
  {
    name: 'state:needs-research',
    color: colors.slate,
    description: 'Needs research / investigation before scope or approach is clear · Set: manual',
  },
  {
    name: 'state:declined',
    color: colors.slate,
    description: 'Reviewed and declined; will not be acted on · Set: manual',
  },
  {
    name: 'state:duplicate',
    color: colors.slate,
    description: 'Duplicate of an existing item; tracked elsewhere · Set: manual',
  },
]

// ============================================================================
// origin:* — who or what filed it
// ============================================================================

const originLabels: readonly LabelDef[] = [
  {
    name: 'origin:agent',
    color: colors.darkPurple,
    description: 'Filed or primarily produced by an AI agent · Set: AI agent or manual',
  },
  {
    name: 'origin:janitor',
    color: colors.darkPurple,
    description: 'Filed by janitor automation · Set: janitor-cli',
  },
]

// ============================================================================
// area:* — lean shared baseline (truly cross-repo subsystems)
// ============================================================================

const sharedAreaLabels: readonly LabelDef[] = [
  {
    name: 'area:nix',
    color: colors.brightBlue,
    description: 'Nix flakes, derivations, FOD hashes, builders · Set: manual',
  },
  {
    name: 'area:typescript',
    color: colors.brightBlue,
    description: 'TypeScript code, tsconfig, and type definitions · Set: manual',
  },
  {
    name: 'area:ci',
    color: colors.brightBlue,
    description: 'CI workflows, runners, and pipeline configuration · Set: manual',
  },
  {
    name: 'area:storybook',
    color: colors.brightBlue,
    description: 'Storybook configuration and stories · Set: manual',
  },
  {
    name: 'area:effect',
    color: colors.brightBlue,
    description: 'Effect framework usage · Set: manual',
  },
  {
    name: 'area:devenv',
    color: colors.brightBlue,
    description: 'devenv tasks, inputs, and environment configuration · Set: manual',
  },
  {
    name: 'area:tooling',
    color: colors.brightBlue,
    description: 'Developer tooling, scripts, and utilities · Set: manual',
  },
  {
    name: 'area:megarepo',
    color: colors.brightBlue,
    description: 'megarepo CLI and conventions · Set: manual',
  },
]

// ============================================================================
// system:* — named systems/products/packages with their own identity
//   Distinct from `area:*` (cross-cutting concerns): a `system:*` value names a
//   thing with its own identity (e.g. a concrete package) that issues and
//   feedback are attributed *to*. Cross-cutting frameworks such as Effect stay
//   on `area:*` (`area:effect`) — they are a concern, not a system. There are no
//   shared `system:*` values; each repo adds its own in its label config.
//
//   Color convention: light purple/violet (`a371f7`) so `system:*` chips read
//   distinctly from the bright-blue `area:*` chips.
// ============================================================================

// ============================================================================
// mq:* — RETIRED merge-queue labels (cleanup only)
//   The merge-queue runtime that owned these (`flakes/merge-queue/crates/mq-core`)
//   is deleted; its successor Hypermerge uses `hy:req/*` + `hy:state/*` (defined in
//   dotfiles' hypermerge flake) and deprecates every `mq:*`. No runtime acts on
//   `mq:*` anymore, so the catalog no longer *provisions* them — it only exports
//   their names as `mqDeprecated` so each repo can DELETE the vestigial live labels
//   by composing them into its `deprecated` list. Do not re-add `mqLabels`.
// ============================================================================

const mqPriorityLevels = [0, 1, 10, 20, 30, 100] as const

/** Every `mq:*` label name, for repos cleaning up the retired merge-queue labels. */
export const mqDeprecated: readonly string[] = [
  'mq:enrolled',
  'mq:merge-held',
  'mq:blocked',
  'mq:needs-agent',
  'mq:agent-active',
  'mq:needs-human',
  'mq:ci-admitted',
  'mq:queue-head',
  'mq:status',
  ...mqPriorityLevels.map((n) => `mq:priority-${n}`),
]

/**
 * @deprecated The `mq:*` axis is retired — no labels are provisioned anymore. This is
 * kept as an empty array purely so existing `...mqLabels` spreads / `mqLabels.map(...)`
 * in consumer repos keep evaluating (non-breaking) until they migrate to `mqDeprecated`.
 * Remove once no consumer references it.
 */
export const mqLabels: readonly LabelDef[] = []

// ============================================================================
// andon:* — cross-machine incident states (see /sk-andon)
// ============================================================================

const andonStateLabels: readonly LabelDef[] = [
  {
    name: 'andon:firing',
    color: colors.red,
    description: 'Andon: actively impacting development right now · Set: andon CLI',
  },
  {
    name: 'andon:degraded',
    color: colors.orange,
    description: 'Andon: partial impact / workaround available · Set: andon CLI',
  },
  {
    name: 'andon:watching',
    color: colors.yellow,
    description: 'Andon: known concern, not yet impacting · Set: andon CLI',
  },
  {
    name: 'andon:claimed',
    color: colors.green,
    description: 'Andon: someone is actively triaging · Set: andon CLI',
  },
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
 * Canonical migrations applied by `devenv tasks run gh:apply-labels` before the legacy
 * labels are deleted. Idempotent: missing labels are no-ops.
 */
export const legacyMigrations: readonly LegacyMigration[] = [
  { from: 'bug', to: 'type:bug' },
  { from: 'enhancement', to: 'type:feature' },
  { from: 'documentation', to: 'type:docs' },
]
