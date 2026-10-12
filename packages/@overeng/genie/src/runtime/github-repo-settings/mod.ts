/**
 * Consumer-facing repository settings builder.
 *
 * Plain-flake consumers import this module from a Nix store path without any `node_modules`, so it
 * must stay free of npm imports. Full wire decoding lives in `build/github-repo-settings/schema.ts`,
 * which ships inside the bundled Genie product.
 */

import type { GenieOutput } from '../core.ts'
import type { GithubRulesetArgs } from '../github-ruleset/mod.ts'
import { joinPath } from '../utils/path.ts'
import {
  normalizeDesiredGithubRepositorySettings,
  type GithubRepositorySettings,
} from './comparison.ts'

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

/** Repository PATCH settings and named ruleset builders composed into one generated envelope. */
export type GithubRepoSettingsArgs = {
  readonly repository: GithubRepositorySettings
  readonly rulesets: readonly (GithubRulesetArgs | GenieOutput<GithubRulesetArgs>)[]
}

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
      : {
          bypass_actors: bypass_actors.map(({ actor_id, actor_type, bypass_mode }) =>
            bypass_mode === undefined
              ? { actor_id, actor_type }
              : { actor_id, actor_type, bypass_mode },
          ),
        }),
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

export {
  diffGithubRepositorySettings,
  normalizeGithubRepositorySettingsForComparison,
  normalizeDesiredGithubRepositorySettings,
  type GithubRepositorySettings,
  type GithubRepositorySettingsDifference,
  type GithubRepositorySettingsComparison,
} from './comparison.ts'
