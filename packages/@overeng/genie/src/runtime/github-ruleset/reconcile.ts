import { readFile } from 'node:fs/promises'

/** Whether to only report drift or update the remote ruleset in place. */
export type RulesetMode = 'check' | 'apply'

/** One normalized field mismatch between generated and remote ruleset state. */
export type RulesetDiff = {
  readonly field: string
  readonly desired: unknown
  readonly actual: unknown
}

/** Inputs required to load and reconcile one repository ruleset. */
export type GithubRulesetOptions = {
  readonly repo: string
  readonly ruleset: string
  readonly file: string
}

/** Outcome of reconciling one repository ruleset against generated settings. */
export type GithubRulesetReport = {
  readonly repo: string
  readonly rulesetName: string
  readonly rulesetId: number
  readonly changed: boolean
  readonly applied: boolean
  readonly diffs: ReadonlyArray<RulesetDiff>
}

type RulesetSummary = {
  readonly id: number
  readonly name: string
}

const controlledFields = [
  'name',
  'target',
  'enforcement',
  'conditions',
  'rules',
  'bypass_actors',
] as const

/** Reconcile one remote GitHub ruleset with the generated JSON file. */
export const reconcileGithubRuleset = async ({
  mode,
  options,
}: {
  readonly mode: RulesetMode
  readonly options: GithubRulesetOptions
}): Promise<GithubRulesetReport> => {
  const desired = JSON.parse(await readFile(options.file, 'utf8')) as unknown
  const summary = await findRuleset({ repo: options.repo, rulesetName: options.ruleset })
  const actual = await ghJson({ endpoint: `repos/${options.repo}/rulesets/${summary.id}` })
  const diffs = diffGithubRuleset({ desired, actual })
  const applied = mode === 'apply' && diffs.length > 0

  if (applied === true) {
    await ghJson({
      endpoint: `repos/${options.repo}/rulesets/${summary.id}`,
      args: ['--method', 'PUT', '--input', options.file],
    })
  }

  return {
    repo: options.repo,
    rulesetName: options.ruleset,
    rulesetId: summary.id,
    changed: diffs.length > 0,
    applied,
    diffs,
  }
}

/** Render a concise CLI summary for one ruleset reconciliation result. */
export const formatGithubRulesetReport = ({
  mode,
  report,
}: {
  readonly mode: RulesetMode
  readonly report: GithubRulesetReport
}): string => {
  if (report.changed === false) {
    const suffix =
      mode === 'apply' ? ' already matches generated settings' : ' matches generated settings'
    return `ok: ${report.repo} ruleset \`${report.rulesetName}\` (${report.rulesetId})${suffix}`
  }

  const action = report.applied === true ? 'applied' : 'drift'
  return [
    `${action}: ${report.repo} ruleset \`${report.rulesetName}\` (${report.rulesetId})`,
    ...report.diffs.map((diff) => `- ${diff.field}`),
  ].join('\n')
}

/** Diff only the ruleset fields this generator owns. */
export const diffGithubRuleset = ({
  desired,
  actual,
}: {
  readonly desired: unknown
  readonly actual: unknown
}): ReadonlyArray<RulesetDiff> => {
  const desiredObject = asRecord(desired)
  const actualObject = asRecord(actual)

  return controlledFields.flatMap((field) => {
    const desiredValue = normalizeRulesetField({ field, value: desiredObject[field] })
    const actualValue = normalizeRulesetField({ field, value: actualObject[field] })

    return stableStringify(desiredValue) === stableStringify(actualValue)
      ? []
      : [{ field, desired: desiredValue, actual: actualValue }]
  })
}

/** Normalize a ruleset payload to the owned fields used for equality checks. */
export const normalizeGithubRulesetForComparison = (value: unknown): Record<string, unknown> => {
  const object = asRecord(value)
  return Object.fromEntries(
    controlledFields.map((field) => [
      field,
      normalizeRulesetField({ field, value: object[field] }),
    ]),
  )
}

const normalizeRulesetField = ({
  field,
  value,
}: {
  readonly field: (typeof controlledFields)[number]
  readonly value: unknown
}): unknown => {
  switch (field) {
    case 'bypass_actors':
      return value === undefined || value === null ? [] : deepSort(value)
    case 'rules':
      return normalizeRules(value)
    default:
      return deepSort(value ?? null)
  }
}

const normalizeRules = (value: unknown): unknown => {
  if (Array.isArray(value) === false) {
    return deepSort(value ?? null)
  }

  return value
    .map(normalizeRule)
    .toSorted((left, right) =>
      String(asRecord(left).type ?? '').localeCompare(String(asRecord(right).type ?? '')),
    )
}

const normalizeRule = (value: unknown): unknown => {
  const rule = deepSort(value)
  const ruleObject = asRecord(rule)

  if (ruleObject.type !== 'pull_request') {
    return rule
  }

  const parameters = asRecord(ruleObject.parameters)
  const { allowed_merge_methods: _allowedMergeMethods, ...restParameters } = parameters

  return deepSort({
    ...ruleObject,
    parameters: restParameters,
  })
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : {}

const deepSort = (value: unknown): unknown => {
  if (Array.isArray(value) === true) {
    return value.map(deepSort)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .toSorted()
      .map((key) => [key, deepSort(object[key])]),
  )
}

const stableStringify = (value: unknown): string => JSON.stringify(deepSort(value))

const findRuleset = async ({
  repo,
  rulesetName,
}: {
  readonly repo: string
  readonly rulesetName: string
}): Promise<RulesetSummary> => {
  const summaries = await ghJson({ endpoint: `repos/${repo}/rulesets` })
  if (Array.isArray(summaries) === false) {
    throw new Error(`expected GitHub rulesets response to be an array for ${repo}`)
  }

  const match = summaries.find((summary): summary is RulesetSummary => {
    const candidate = summary as Partial<RulesetSummary>
    return candidate.name === rulesetName && typeof candidate.id === 'number'
  })

  if (match === undefined) {
    throw new Error(`repo ${repo} has no ruleset named \`${rulesetName}\``)
  }

  return match
}

const ghJson = async ({
  endpoint,
  args = [],
}: {
  readonly endpoint: string
  readonly args?: ReadonlyArray<string>
}): Promise<unknown> => {
  const proc = Bun.spawn(['gh', 'api', endpoint, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(
      `gh api ${[endpoint, ...args].join(' ')} failed with exit ${exitCode}\n${stderr.trim()}`,
    )
  }

  return stdout.trim() === '' ? undefined : JSON.parse(stdout)
}
