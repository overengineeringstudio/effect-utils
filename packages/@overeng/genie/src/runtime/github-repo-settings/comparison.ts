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

/** Desired repository fields and the matching projection of a live GitHub response. */
export type GithubRepositorySettingsComparison = {
  readonly desired: GithubRepositorySettings
  readonly actual: Readonly<Record<string, unknown>>
}

/** One declared repository field whose desired and live values differ. */
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

/** Reject typos and remove explicitly undefined values; value types are the engine's job. */
export const normalizeDesiredGithubRepositorySettings = (
  desired: GithubRepositorySettings,
): GithubRepositorySettings => {
  const unknown = Object.keys(desired).filter(
    (field) => Object.hasOwn(repositorySettingsFields, field) === false,
  )
  if (unknown.length > 0) {
    throw new Error(`GitHub repository settings has unknown field(s): ${unknown.join(', ')}`)
  }
  return Object.fromEntries(Object.entries(desired).filter(([, value]) => value !== undefined))
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
