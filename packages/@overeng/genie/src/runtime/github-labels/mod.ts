/**
 * Type-safe GitHub repository label generator.
 *
 * Generates JSON describing the desired set of GitHub Issue/PR labels for a
 * repository. The JSON is consumed by `mq-cli repo labels {check|apply|migrate}`
 * which diffs it against live GitHub state and creates/updates/deletes labels.
 *
 * @see https://docs.github.com/en/rest/issues/labels
 */

import type { GenieOutput, Strict } from '../mod.ts'

/**
 * A single GitHub label definition.
 *
 * Colors are 6-digit hex without the leading `#` (GitHub stores them this way).
 * Case is normalized to lowercase by the reconciler before diffing.
 */
export interface LabelDef {
  /** Label name (e.g. `type:bug`, `area:nix`). */
  name: string
  /** Short, action-oriented description shown in the GitHub UI on hover. */
  description: string
  /** 6-digit hex color without leading `#` (e.g. `D73A4A`). */
  color: string
}

/**
 * Declarative migration from a legacy label to a current label.
 *
 * Applied by `mq-cli repo labels migrate`: every open & closed issue/PR
 * carrying `from` is relabeled to `to`, then the `from` label is deleted from
 * the repo (provided it is also listed in `deprecated`).
 */
export interface LegacyMigration {
  /** Name of the legacy label to migrate away from. */
  from: string
  /** Name of the current label to apply in its place. */
  to: string
}

/**
 * Arguments for {@link githubLabels}.
 */
export interface GithubLabelsArgs {
  /** The full desired set of labels. The reconciler creates/updates each one. */
  labels: readonly LabelDef[]
  /**
   * Label names that should be deleted from the repo when present.
   *
   * Typically used to retire GitHub's bare default labels (`bug`, `enhancement`,
   * `documentation`, etc.) once they have been superseded by the `type:*` axis.
   *
   * Deletion only happens via `mq-cli repo labels apply`. If a `deprecated`
   * label still has open issues attached, declare a {@link LegacyMigration} so
   * `mq-cli repo labels migrate` can move them first.
   */
  deprecated?: readonly string[]
  /**
   * One-shot migrations to run before {@link deprecated} labels are deleted.
   *
   * The reconciler is idempotent: if the `from` label is missing on the
   * repo there is nothing to do.
   */
  legacyMigrations?: readonly LegacyMigration[]
}

/**
 * Creates a GitHub labels JSON configuration.
 *
 * Returns a `GenieOutput` whose `.data` is the desired-state record consumed
 * by `mq-cli repo labels`. Compose freely with shared catalog exports (e.g.
 * `commonLabels`, `mqLabels`, `andonLabels` from `effect-utils/genie/external.ts`).
 *
 * @example
 * ```ts
 * import { githubLabels, commonLabels, mqLabels } from '<effect-utils>/genie/external.ts'
 *
 * export default githubLabels({
 *   labels: [
 *     ...commonLabels,
 *     ...mqLabels,
 *     { name: 'area:my-thing', description: 'My subsystem', color: '1d76db' },
 *   ],
 *   deprecated: ['bug', 'enhancement', 'documentation'],
 *   legacyMigrations: [
 *     { from: 'bug', to: 'type:bug' },
 *     { from: 'enhancement', to: 'type:feature' },
 *     { from: 'documentation', to: 'type:docs' },
 *   ],
 * })
 * ```
 */
export const githubLabels = <const T extends GithubLabelsArgs>(
  args: Strict<T, GithubLabelsArgs>,
): GenieOutput<T> => ({
  data: args,
  stringify: (_ctx) => JSON.stringify(normalize(args), null, 2) + '\n',
})

/** Sort labels by name and lowercase colors so JSON output is deterministic. */
const normalize = (args: GithubLabelsArgs): Record<string, unknown> => {
  const normalizedLabels: LabelDef[] = []
  for (const label of args.labels) {
    normalizedLabels.push({
      name: label.name,
      color: label.color.toLowerCase(),
      description: label.description,
    })
  }
  const result: Record<string, unknown> = {
    labels: normalizedLabels.toSorted((a, b) => a.name.localeCompare(b.name)),
  }
  if (args.deprecated !== undefined) {
    result.deprecated = [...args.deprecated].toSorted()
  }
  if (args.legacyMigrations !== undefined) {
    result.legacyMigrations = [...args.legacyMigrations].toSorted((a, b) =>
      a.from.localeCompare(b.from),
    )
  }
  return result
}
