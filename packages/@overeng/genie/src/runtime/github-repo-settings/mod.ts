import { Effect, Schema } from 'effect'

import type { GenieOutput } from '../core.ts'
import type { GithubRulesetArgs } from '../github-ruleset/mod.ts'
import { joinPath } from '../utils/path.ts'

/** Writable GitHub repository PATCH fields. Omitted fields remain unmanaged. */
export const GithubRepositorySettings = Schema.Struct({
  description: Schema.optional(Schema.NullOr(Schema.String)),
  homepage: Schema.optional(Schema.NullOr(Schema.String)),
  private: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(Schema.Literals(['public', 'private', 'internal'])),
  default_branch: Schema.optional(Schema.NonEmptyString),
  has_issues: Schema.optional(Schema.Boolean),
  has_projects: Schema.optional(Schema.Boolean),
  has_wiki: Schema.optional(Schema.Boolean),
  has_discussions: Schema.optional(Schema.Boolean),
  is_template: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  allow_forking: Schema.optional(Schema.Boolean),
  web_commit_signoff_required: Schema.optional(Schema.Boolean),
  allow_auto_merge: Schema.optional(Schema.Boolean),
  delete_branch_on_merge: Schema.optional(Schema.Boolean),
  allow_update_branch: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_merge_commit: Schema.optional(Schema.Boolean),
  allow_rebase_merge: Schema.optional(Schema.Boolean),
  squash_merge_commit_title: Schema.optional(Schema.Literals(['PR_TITLE', 'COMMIT_OR_PR_TITLE'])),
  squash_merge_commit_message: Schema.optional(
    Schema.Literals(['PR_BODY', 'COMMIT_MESSAGES', 'BLANK']),
  ),
  merge_commit_title: Schema.optional(Schema.Literals(['PR_TITLE', 'MERGE_MESSAGE'])),
  merge_commit_message: Schema.optional(Schema.Literals(['PR_BODY', 'PR_TITLE', 'BLANK'])),
}).annotate({ identifier: 'GithubRepoSettings.RepositorySettings' })
export type GithubRepositorySettings = typeof GithubRepositorySettings.Type

/** Ruleset wire shape; open records retain GitHub's evolving rule parameters. */
export const GithubRulesetPayload = Schema.Struct({
  name: Schema.NonEmptyString,
  enforcement: Schema.Literals(['active', 'disabled', 'evaluate']),
  target: Schema.Literals(['branch', 'tag', 'push']).pipe(
    Schema.withDecodingDefault(Effect.succeed('branch' as const)),
  ),
  conditions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  rules: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  bypass_actors: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
}).annotate({ identifier: 'GithubRepoSettings.RulesetPayload' })
export type GithubRulesetPayload = typeof GithubRulesetPayload.Type

/** Desired envelope. Duplicate names are invalid before any reconciliation starts. */
export const GithubRepoSettings = Schema.Struct({
  repository: GithubRepositorySettings,
  rulesets: Schema.Array(GithubRulesetPayload),
})
  .check(
    Schema.makeFilter(
      ({ rulesets }) => new Set(rulesets.map(({ name }) => name)).size === rulesets.length,
      {
        message: 'Ruleset names must be unique within a repository',
      },
    ),
  )
  .annotate({ identifier: 'GithubRepoSettings.Payload' })
export type GithubRepoSettings = typeof GithubRepoSettings.Type

export type GithubRepoSettingsArgs = {
  readonly repository: GithubRepositorySettings
  readonly rulesets: readonly (GithubRulesetArgs | GenieOutput<GithubRulesetArgs>)[]
}

/** Validate desired settings, rejecting typos and removing explicitly undefined values. */
export const normalizeDesiredGithubRepositorySettings = (
  desired: GithubRepositorySettings,
): GithubRepositorySettings => {
  const decoded = Schema.decodeSync(GithubRepositorySettings, { onExcessProperty: 'error' })(
    desired,
  )
  return Object.fromEntries(Object.entries(decoded).filter(([, value]) => value !== undefined))
}

/** Compose repository PATCH settings and rulesets into one generated settings file. */
export const githubRepoSettings = (
  args: GithubRepoSettingsArgs,
): GenieOutput<GithubRepoSettings> => {
  const data = Schema.decodeUnknownSync(GithubRepoSettings)({
    repository: normalizeDesiredGithubRepositorySettings(args.repository),
    rulesets: args.rulesets.map((ruleset) => ('data' in ruleset ? ruleset.data : ruleset)),
  })
  return {
    data,
    stringify: (ctx) =>
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))({
        $genie: {
          source: joinPath(ctx.location, 'repo-settings.json.genie.ts'),
          warning: 'DO NOT EDIT - changes will be overwritten',
        },
        ...data,
      }) + '\n',
  }
}

export {
  diffGithubRepositorySettings,
  normalizeGithubRepositorySettingsForComparison,
  type GithubRepositorySettingsDifference,
  type GithubRepositorySettingsComparison,
} from './comparison.ts'
