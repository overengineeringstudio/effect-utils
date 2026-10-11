import { Schema } from 'effect'

import {
  diffGithubRuleset,
  ghJson,
  type RulesetDiff,
  type RulesetMode,
} from '../github-ruleset/reconcile.ts'
import { diffGithubRepositorySettings } from './comparison.ts'
import type { GithubRepoSettings as GithubRepoSettingsData } from './mod.ts'
import { GithubRepoSettings, GithubRepositorySettings, GithubRulesetPayload } from './schema.ts'

export class GithubRepoSettingsError extends Schema.TaggedError<GithubRepoSettingsError>()(
  'GithubRepoSettingsError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type GithubRepoSettingsOptions = {
  readonly repo: string
  readonly file: string
  /** Legacy single-ruleset files may additionally assert their expected name. */
  readonly ruleset?: string | undefined
}

export type GithubRepoSettingsReport = {
  readonly repo: string
  readonly changed: boolean
  readonly applied: boolean
  readonly repository: ReadonlyArray<RulesetDiff>
  readonly rulesets: ReadonlyArray<{
    readonly name: string
    readonly id: number | undefined
    readonly created: boolean
    readonly diffs: ReadonlyArray<RulesetDiff>
  }>
}

const Json = Schema.fromJsonString(Schema.Unknown)
const RepositoryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
const RulesetSummary = Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString })
const RulesetPages = Schema.Array(Schema.Array(RulesetSummary))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
/** Read both the repository envelope and historical single-ruleset files. */
export const decodeGithubRepoSettings = (value: unknown): GithubRepoSettingsData => {
  const object = Schema.decodeUnknownSync(JsonObject)(value)
  const settings =
    'rulesets' in object || 'repository' in object
      ? Schema.decodeUnknownSync(GithubRepoSettings)({
          ...object,
          repository: Schema.decodeUnknownSync(GithubRepositorySettings, {
            onExcessProperty: 'error',
          })(object.repository),
        })
      : Schema.decodeSync(GithubRepoSettings)({
          repository: {},
          rulesets: [Schema.decodeUnknownSync(GithubRulesetPayload)(object)],
        })
  return settings
}

/** Reconcile only declared repository fields and named repository-owned rulesets. Never deletes other rulesets. */
export const reconcileGithubRepoSettings = async ({
  mode,
  options,
}: {
  readonly mode: RulesetMode
  readonly options: GithubRepoSettingsOptions
}): Promise<GithubRepoSettingsReport> => {
  Schema.decodeSync(RepositoryName)(options.repo)
  const desired = decodeGithubRepoSettings(
    Schema.decodeSync(Json)(await Bun.file(options.file).text()),
  )
  if (
    options.ruleset !== undefined &&
    !desired.rulesets.some((ruleset) => ruleset.name === options.ruleset)
  ) {
    throw new GithubRepoSettingsError({
      message: `${options.file} has no ruleset named \`${options.ruleset}\``,
    })
  }

  // Complete all reads and diffs before making the first mutation.
  const repositoryDiffs =
    Object.keys(desired.repository).length === 0
      ? []
      : diffGithubRepositorySettings({
          desired: desired.repository,
          actual: Schema.decodeUnknownSync(JsonObject)(
            await ghJson({ endpoint: `repos/${options.repo}` }),
          ),
        })
  const summaries =
    desired.rulesets.length === 0
      ? []
      : Schema.decodeUnknownSync(RulesetPages)(
          await ghJson({
            endpoint: `repos/${options.repo}/rulesets?includes_parents=false&per_page=100`,
            args: ['--paginate', '--slurp'],
          }),
        ).flat()
  const plannedRulesets = []
  for (const ruleset of desired.rulesets) {
    const matches = summaries.filter((summary) => summary.name === ruleset.name)
    if (matches.length > 1) {
      throw new GithubRepoSettingsError({
        message: `repo ${options.repo} has multiple rulesets named \`${ruleset.name}\``,
      })
    }
    const summary = matches[0]
    const diffs =
      summary === undefined
        ? [{ field: 'ruleset', desired: ruleset, actual: undefined }]
        : diffGithubRuleset({
            desired: ruleset,
            actual: Schema.decodeUnknownSync(JsonObject)(
              await ghJson({ endpoint: `repos/${options.repo}/rulesets/${summary.id}` }),
            ),
          })
    plannedRulesets.push({ payload: ruleset, id: summary?.id, diffs })
  }

  const changed =
    repositoryDiffs.length > 0 || plannedRulesets.some((ruleset) => ruleset.diffs.length > 0)
  if (mode === 'apply' && repositoryDiffs.length > 0) {
    await ghJson({
      endpoint: `repos/${options.repo}`,
      args: ['--method', 'PATCH'],
      body: Object.fromEntries(repositoryDiffs.map((diff) => [diff.field, diff.desired])),
    })
  }
  const rulesets = []
  for (const ruleset of plannedRulesets) {
    let id = ruleset.id
    const created = mode === 'apply' && id === undefined
    if (mode === 'apply' && ruleset.diffs.length > 0) {
      const result = await ghJson({
        endpoint:
          id === undefined
            ? `repos/${options.repo}/rulesets`
            : `repos/${options.repo}/rulesets/${id}`,
        args: ['--method', id === undefined ? 'POST' : 'PUT'],
        body: ruleset.payload,
      })
      id = Schema.decodeUnknownSync(RulesetSummary)(result).id
    }
    rulesets.push({ name: ruleset.payload.name, id, created, diffs: ruleset.diffs })
  }
  return {
    repo: options.repo,
    changed,
    applied: mode === 'apply' && changed,
    repository: repositoryDiffs,
    rulesets,
  }
}

const renderValue = (value: unknown): string =>
  value === undefined ? '(missing)' : Schema.encodeSync(Json)(value)

/** CLI diff includes values, so check mode is useful without a second API query. */
export const formatGithubRepoSettingsReport = ({
  mode,
  report,
}: {
  readonly mode: RulesetMode
  readonly report: GithubRepoSettingsReport
}): string => {
  if (!report.changed) return `ok: ${report.repo} matches generated repository settings`
  const action = mode === 'apply' && report.applied ? 'applied' : 'drift'
  return [
    `${action}: ${report.repo} repository settings`,
    ...report.repository.map(
      (diff) =>
        `- repository.${diff.field}: ${renderValue(diff.actual)} -> ${renderValue(diff.desired)}`,
    ),
    ...report.rulesets.flatMap((ruleset) =>
      ruleset.diffs.map(
        (diff) =>
          `- rulesets[${ruleset.name}].${diff.field}: ${renderValue(diff.actual)} -> ${renderValue(diff.desired)}`,
      ),
    ),
  ].join('\n')
}
