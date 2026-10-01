/**
 * Consumer-facing repository settings builder.
 *
 * Plain-flake consumers import this module from a Nix store path without any `node_modules`, so it
 * must stay free of npm imports. Full wire decoding lives in `src/build/github-settings/schema.ts`
 * on the reconcile side, which ships inside the bundled Genie product.
 */

import type { GenieOutput } from '../core.ts'
import type { GithubRulesetArgs } from '../github-ruleset/mod.ts'
import { joinPath } from '../utils/path.ts'

/** Writable GitHub repository PATCH fields. Omitted fields remain unmanaged. */
export type GithubRepositorySettings = {
  readonly description?: string | null | undefined
  readonly homepage?: string | null | undefined
  readonly private?: boolean | undefined
  readonly visibility?: 'public' | 'private' | 'internal' | undefined
  readonly default_branch?: string | undefined
  readonly has_issues?: boolean | undefined
  readonly has_projects?: boolean | undefined
  readonly has_wiki?: boolean | undefined
  readonly has_discussions?: boolean | undefined
  readonly is_template?: boolean | undefined
  readonly archived?: boolean | undefined
  readonly allow_forking?: boolean | undefined
  readonly web_commit_signoff_required?: boolean | undefined
  readonly allow_auto_merge?: boolean | undefined
  readonly delete_branch_on_merge?: boolean | undefined
  readonly allow_update_branch?: boolean | undefined
  readonly allow_squash_merge?: boolean | undefined
  readonly allow_merge_commit?: boolean | undefined
  readonly allow_rebase_merge?: boolean | undefined
  readonly squash_merge_commit_title?: 'PR_TITLE' | 'COMMIT_OR_PR_TITLE' | undefined
  readonly squash_merge_commit_message?: 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK' | undefined
  readonly merge_commit_title?: 'PR_TITLE' | 'MERGE_MESSAGE' | undefined
  readonly merge_commit_message?: 'PR_BODY' | 'PR_TITLE' | 'BLANK' | undefined
}

/** Ruleset wire shape; open records retain GitHub's evolving rule parameters. */
export type GithubRulesetPayload = {
  readonly name: string
  readonly enforcement: 'active' | 'disabled' | 'evaluate'
  readonly target: 'branch' | 'tag' | 'push'
  readonly conditions?: { readonly [key: string]: unknown } | undefined
  readonly rules: ReadonlyArray<{ readonly [key: string]: unknown }>
  readonly bypass_actors?: ReadonlyArray<{ readonly [key: string]: unknown }> | undefined
}

/** Generated envelope: repository PATCH fields plus rulesets identified by unique name. */
export type GithubRepoSettings = {
  readonly repository: GithubRepositorySettings
  readonly rulesets: ReadonlyArray<GithubRulesetPayload>
}

/** Builder input: repository PATCH fields plus rulesets as raw args or `githubRuleset` outputs. */
export type GithubRepoSettingsArgs = {
  readonly repository: GithubRepositorySettings
  readonly rulesets: readonly (GithubRulesetArgs | GenieOutput<GithubRulesetArgs>)[]
}

/** Exhaustive over the type, so a field cannot be typed but rejected (or accepted but untyped). */
const repositorySettingsFields = {
  description: true,
  homepage: true,
  private: true,
  visibility: true,
  default_branch: true,
  has_issues: true,
  has_projects: true,
  has_wiki: true,
  has_discussions: true,
  is_template: true,
  archived: true,
  allow_forking: true,
  web_commit_signoff_required: true,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
  allow_update_branch: true,
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: true,
  squash_merge_commit_title: true,
  squash_merge_commit_message: true,
  merge_commit_title: true,
  merge_commit_message: true,
} as const satisfies Record<keyof GithubRepositorySettings, true>

const rulesetPayloadFields = {
  name: true,
  enforcement: true,
  target: true,
  conditions: true,
  rules: true,
  bypass_actors: true,
} as const satisfies Record<keyof GithubRulesetPayload, true>

const rejectUnknownFields = ({
  value,
  known,
  label,
}: {
  readonly value: object
  readonly known: Readonly<Record<string, true>>
  readonly label: string
}): void => {
  const unknown = Object.keys(value).filter((field) => Object.hasOwn(known, field) === false)
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`)
  }
}

/** Reject typos and remove explicitly undefined values; value types are the reconcile side's job. */
export const normalizeDesiredGithubRepositorySettings = (
  desired: GithubRepositorySettings,
): GithubRepositorySettings => {
  rejectUnknownFields({
    value: desired,
    known: repositorySettingsFields,
    label: 'GitHub repository settings',
  })
  return Object.fromEntries(Object.entries(desired).filter(([, value]) => value !== undefined))
}

/** GitHub defaults an omitted ruleset target to `branch`; the generated file states it explicitly. */
const toRulesetPayload = (ruleset: GithubRulesetArgs): GithubRulesetPayload => {
  rejectUnknownFields({
    value: ruleset,
    known: rulesetPayloadFields,
    label: `GitHub ruleset \`${ruleset.name}\``,
  })
  if (typeof ruleset.name !== 'string' || ruleset.name.length === 0) {
    throw new Error('GitHub ruleset name must be a non-empty string')
  }
  const { name, enforcement, target = 'branch', conditions, rules, bypass_actors } = ruleset
  return {
    name,
    enforcement,
    target,
    // Spreads turn the typed interfaces into plain objects, which match the open wire records.
    ...(conditions === undefined ? {} : { conditions: { ...conditions } }),
    rules,
    ...(bypass_actors === undefined
      ? {}
      : { bypass_actors: bypass_actors.map((actor) => ({ ...actor })) }),
  }
}

/** Compose repository PATCH settings and rulesets into one generated settings file. */
export const githubRepoSettings = (
  args: GithubRepoSettingsArgs,
): GenieOutput<GithubRepoSettings> => {
  const rulesets = args.rulesets.map((ruleset) =>
    toRulesetPayload('data' in ruleset ? ruleset.data : ruleset),
  )
  const duplicates = rulesets
    .map(({ name }) => name)
    .filter((name, index, names) => names.indexOf(name) !== index)
  if (duplicates.length > 0) {
    throw new Error(
      `Ruleset names must be unique within a repository; duplicated: ${[...new Set(duplicates)].join(', ')}`,
    )
  }
  const data: GithubRepoSettings = {
    repository: normalizeDesiredGithubRepositorySettings(args.repository),
    rulesets,
  }
  return {
    data,
    stringify: (ctx) =>
      JSON.stringify(
        {
          $genie: {
            source: joinPath(ctx.location, 'repo-settings.json.genie.ts'),
            warning: 'DO NOT EDIT - changes will be overwritten',
          },
          ...data,
        },
        null,
        2,
      ) + '\n',
  }
}
