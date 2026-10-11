import { normalizeDesiredGithubRepositorySettings, type GithubRepositorySettings } from './mod.ts'

export type GithubRepositorySettingsComparison = {
  readonly desired: GithubRepositorySettings
  readonly actual: Readonly<Record<string, unknown>>
}

export type GithubRepositorySettingsDifference = {
  readonly field: string
  readonly desired: GithubRepositorySettings[keyof GithubRepositorySettings]
  readonly actual: unknown
}

/**
 * Project the remote response onto explicitly desired fields only.
 * Missing and null remote values remain distinct from false (and from each other).
 * Remote metadata and unmanaged settings are intentionally neither decoded nor compared.
 */
export const normalizeGithubRepositorySettingsForComparison = ({
  desired,
  actual,
}: {
  readonly desired: GithubRepositorySettings
  readonly actual: Readonly<Record<string, unknown>>
}): GithubRepositorySettingsComparison => {
  const normalizedDesired = normalizeDesiredGithubRepositorySettings(desired)
  return {
    desired: normalizedDesired,
    actual: Object.fromEntries(
      Object.keys(normalizedDesired).map((field) => [field, actual[field]]),
    ),
  }
}

/** Return drift only for explicitly desired repository PATCH fields. */
export const diffGithubRepositorySettings = (args: {
  readonly desired: GithubRepositorySettings
  readonly actual: Readonly<Record<string, unknown>>
}): readonly GithubRepositorySettingsDifference[] => {
  const { desired, actual } = normalizeGithubRepositorySettingsForComparison(args)
  return Object.entries(desired).flatMap(([field, value]) =>
    Object.is(value, actual[field]) === true
      ? []
      : [{ field, desired: value, actual: actual[field] }],
  )
}
