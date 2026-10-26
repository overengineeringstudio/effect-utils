import type { GitHubWorkflowArgs } from './mod.ts'

/** Stable identifiers for generic workflow admission rules. */
export type WorkflowPolicyRule =
  | 'hosted-runner'
  | 'namespace-runner'
  | 'runner-not-admitted'
  | 'dynamic-runner'
  | 'pull-request-target'
  | 'banned-action'
  | 'setup-action-cache'
  | 'docker-gha-cache'
  | 'runner-fallback'
  | 'runner-label-mix'

/** Stable, exact identity for an observed violation and its report-mode ledger entry. */
export type WorkflowPolicyViolation = {
  readonly repository: string
  readonly workflow: string
  readonly job: string
  readonly rule: WorkflowPolicyRule
  readonly path: string
  readonly value: string
}

/** Exceptions are scoped to one job and rule, never glob patterns. `*` denotes workflow scope only. */
export type WorkflowPolicyException = Pick<
  WorkflowPolicyViolation,
  'repository' | 'workflow' | 'job' | 'rule'
> & {
  readonly owner: string
  readonly approver: string
  readonly justification: string
  /** Inclusive UTC calendar date, YYYY-MM-DD. */
  readonly expiry: string
  readonly trackingIssue: string
}

/** Generator-only metadata. No configuration or exception data is serialized to YAML. */
export type WorkflowPolicy = {
  readonly repository: string
  readonly workflow: string
  readonly mode?: 'enforce' | 'report'
  readonly admittedRunnerLabels: readonly string[]
  /** These labels must be the only label in an individual runner selection. */
  readonly exclusiveRunnerLabels?: readonly string[]
  readonly bannedHostedRunners?: boolean
  readonly bannedNamespaceRunners?: boolean
  readonly banPullRequestTarget?: boolean
  readonly banDockerGhaCache?: boolean
  /** Action repository (optionally a subpath), without a ref; matches every ref and subpath. */
  readonly bannedActions?: readonly string[]
  /** Enablement is any nonempty value other than false; omitted inputs use defaultEnabled. */
  readonly setupActionCaches?: readonly {
    readonly action: string
    readonly input: string
    readonly defaultEnabled: boolean
    /** Only exact vN/vN.N/vN.N.N tags older than this major omit this cache control. */
    readonly minimumMajor?: number
    /** Boolean opt-out controls must explicitly equal this value to disable caching. */
    readonly enabledUnless?: 'false' | 'true'
  }[]
  /** Explicit finite output contracts; only exact needs.<job>.outputs.<name> expressions qualify. */
  readonly admittedRunnerOutputs?: readonly {
    readonly expression: string
    readonly labels: readonly string[]
  }[]
  readonly neverExceptableRules?: readonly WorkflowPolicyRule[]
  readonly exceptions?: readonly WorkflowPolicyException[]
  readonly ledger?: readonly WorkflowPolicyViolation[]
}

/** Structured admission or report-ledger failure. */
export type WorkflowPolicyIssue = {
  readonly kind: 'VIOLATION' | 'NEW' | 'STALE' | 'INVALID_EXCEPTION' | 'INVALID_POLICY'
  readonly message: string
  readonly violation?: WorkflowPolicyViolation
}

/** Aggregated workflow policy failures, including exact violation identities. */
export class WorkflowPolicyError extends Error {
  readonly _tag = 'WorkflowPolicyError'
  readonly issues: readonly WorkflowPolicyIssue[]
  constructor(issues: readonly WorkflowPolicyIssue[]) {
    super(issues.map((issue) => `${issue.kind}: ${issue.message}`).join('\n'))
    this.name = 'WorkflowPolicyError'
    this.issues = issues
  }
}

const rules: readonly WorkflowPolicyRule[] = [
  'hosted-runner',
  'namespace-runner',
  'runner-not-admitted',
  'dynamic-runner',
  'pull-request-target',
  'banned-action',
  'setup-action-cache',
  'docker-gha-cache',
  'runner-fallback',
  'runner-label-mix',
]
const neverExceptable: Partial<Record<WorkflowPolicyRule, true>> = {
  'hosted-runner': true,
  'namespace-runner': true,
  'banned-action': true,
  'setup-action-cache': true,
  'docker-gha-cache': true,
  'runner-fallback': true,
  'runner-label-mix': true,
}

/** Decode a checked-in JSON ledger without weakening its rule and identity types. */
export const decodeWorkflowPolicyLedger = (value: unknown): readonly WorkflowPolicyViolation[] => {
  if (Array.isArray(value) === false)
    throw new WorkflowPolicyError([{ kind: 'INVALID_POLICY', message: 'Ledger must be an array.' }])
  return value.map((entry: unknown, index): WorkflowPolicyViolation => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('repository' in entry) ||
      typeof entry.repository !== 'string' ||
      !('workflow' in entry) ||
      typeof entry.workflow !== 'string' ||
      !('job' in entry) ||
      typeof entry.job !== 'string' ||
      !('rule' in entry) ||
      typeof entry.rule !== 'string' ||
      !('path' in entry) ||
      typeof entry.path !== 'string' ||
      !('value' in entry) ||
      typeof entry.value !== 'string'
    ) {
      throw new WorkflowPolicyError([
        { kind: 'INVALID_POLICY', message: `Invalid ledger entry ${index}.` },
      ])
    }
    const rule = rules.find((candidate) => candidate === entry.rule)
    if (rule === undefined)
      throw new WorkflowPolicyError([
        { kind: 'INVALID_POLICY', message: `Unknown ledger rule at ${index}.` },
      ])
    return {
      repository: entry.repository,
      workflow: entry.workflow,
      job: entry.job,
      rule,
      path: entry.path,
      value: entry.value,
    }
  })
}
const matchesAction = ({ uses, action }: { uses: string; action: string }): boolean => {
  const name = uses.split('@')[0]!.toLowerCase()
  const banned = action.toLowerCase()
  return name === banned || name.startsWith(`${banned}/`)
}
const outputExpression =
  /^\$\{\{\s*(?:needs\.[\w-]+\.outputs\.[\w-]+|fromJSON\(\s*needs\.[\w-]+\.outputs\.[\w-]+\s*\))\s*\}\}$/

/** Expand finite matrices using GitHub's include/ exclude semantics, retaining object-valued axes. */
const matrixRows = (
  matrix: NonNullable<GitHubWorkflowArgs['jobs'][string]['strategy']>['matrix'],
): readonly Record<string, unknown>[] | undefined => {
  if (matrix === undefined || typeof matrix === 'string') return undefined
  const axes = Object.entries(matrix).filter(([key]) => key !== 'include' && key !== 'exclude')
  let rows: Record<string, unknown>[] = axes.length === 0 ? [] : [{}]
  for (const [key, values] of axes) {
    if (Array.isArray(values) === false) return undefined
    if (rows.length * values.length > 256) return undefined
    rows = rows.flatMap((row) => values.map((value) => Object.assign({}, row, { [key]: value })))
    // GitHub rejects larger matrices; do not let policy expansion consume unbounded memory.
    if (rows.length > 256) return undefined
  }
  if (matrix.exclude !== undefined && Array.isArray(matrix.exclude) === false) return undefined
  for (const exclude of matrix.exclude ?? []) {
    if (typeof exclude !== 'object' || exclude === null || Array.isArray(exclude) === true)
      return undefined
    rows = rows.filter(
      (row) =>
        Object.entries(exclude).every(
          ([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value),
        ) === false,
    )
  }
  const originals = [...rows]
  if (matrix.include !== undefined && Array.isArray(matrix.include) === false) return undefined
  for (const include of matrix.include ?? []) {
    if (typeof include !== 'object' || include === null || Array.isArray(include) === true)
      return undefined
    let merged = false
    rows = rows.map((row, index) => {
      const original = originals[index]
      if (
        original === undefined ||
        axes.some(
          ([key]) =>
            key in include && JSON.stringify(original[key]) !== JSON.stringify(include[key]),
        ) === true
      )
        return row
      merged = true
      return { ...row, ...include }
    })
    if (merged === false) rows.push(include)
  }
  return rows
}

/** Collect raw violations; exception and ledger evaluation belongs to validateWorkflowPolicy. */
export const collectWorkflowPolicyViolations = ({
  workflow,
  policy,
}: {
  workflow: GitHubWorkflowArgs
  policy: WorkflowPolicy
}): WorkflowPolicyViolation[] => {
  const violations: WorkflowPolicyViolation[] = []
  const add = ({
    job,
    rule,
    path,
    value,
  }: Pick<WorkflowPolicyViolation, 'job' | 'rule' | 'path' | 'value'>): void => {
    const violation = {
      repository: policy.repository,
      workflow: policy.workflow,
      job,
      rule,
      path,
      value,
    }
    if (violations.some((entry) => violationKey(entry) === violationKey(violation)) === false)
      violations.push(violation)
  }
  const labelRules = ({ job, path, label }: { job: string; path: string; label: string }): void => {
    if (
      policy.bannedHostedRunners !== false &&
      /^(?:ubuntu-|macos-|windows-)|-latest$/i.test(label) === true
    )
      add({ job, rule: 'hosted-runner', path, value: label })
    if (
      policy.bannedNamespaceRunners !== false &&
      /^(?:namespace-profile-|nscloud-|namespace-features:)/i.test(label) === true
    )
      add({ job, rule: 'namespace-runner', path, value: label })
    if (policy.admittedRunnerLabels.includes(label) === false)
      add({ job, rule: 'runner-not-admitted', path, value: label })
  }
  const events =
    typeof workflow.on === 'string'
      ? [workflow.on]
      : Array.isArray(workflow.on) === true
        ? workflow.on
        : Object.keys(workflow.on)
  if (policy.banPullRequestTarget !== false && events.includes('pull_request_target') === true)
    add({
      job: '*',
      rule: 'pull-request-target',
      path: 'on.pull_request_target',
      value: 'pull_request_target',
    })
  for (const [job, config] of Object.entries(workflow.jobs)) {
    const path = `jobs.${job}.runs-on`
    const checkRunner = ({
      runner,
      resolveMatrix,
    }: {
      runner: unknown
      resolveMatrix: boolean
    }): void => {
      if (Array.isArray(runner) === true) {
        if (runner.length === 0) add({ job, rule: 'dynamic-runner', path, value: '[]' })
        for (const label of runner) checkRunner({ runner: label, resolveMatrix })
        return
      }
      if (typeof runner !== 'string' || runner.length === 0) {
        add({ job, rule: 'dynamic-runner', path, value: String(runner) })
        return
      }
      if (runner.includes('${{') === false) {
        labelRules({ job, path, label: runner })
        return
      }
      // Even unresolved expressions must not hide forbidden literal fallbacks.
      if (runner.includes('||') === true) add({ job, rule: 'runner-fallback', path, value: runner })
      for (const literal of runner.matchAll(/'((?:[^']|'')*)'|"([^"]*)"/g)) {
        const value = (literal[1] ?? literal[2])!.replaceAll("''", "'")
        if (
          /^(?:ubuntu-|macos-|windows-|namespace-profile-|nscloud-|namespace-features:)|-latest$/i.test(
            value,
          ) === true
        )
          labelRules({ job, path, label: value })
      }
      const reference = /^\$\{\{\s*matrix\.([\w.-]+)\s*\}\}$/.exec(runner)
      if (resolveMatrix === true && reference !== null) {
        const rows = matrixRows(config.strategy?.matrix)
        if (rows !== undefined && rows.length > 0) {
          for (const row of rows) {
            let value: unknown = row
            for (const key of reference[1]!.split('.'))
              value =
                typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
            checkRunner({ runner: value, resolveMatrix: false })
          }
          return
        }
      }
      const contract = policy.admittedRunnerOutputs?.find((output) => output.expression === runner)
      if (
        contract !== undefined &&
        outputExpression.test(runner) === true &&
        contract.labels.length > 0
      ) {
        for (const label of contract.labels) {
          if (label.includes('${{') === true)
            add({ job, rule: 'dynamic-runner', path, value: label })
          else labelRules({ job, path, label })
        }
        return
      }
      add({ job, rule: 'dynamic-runner', path, value: runner })
    }
    checkRunner({ runner: config['runs-on'], resolveMatrix: true })
    // Compare labels within each concrete selection, not across independent matrix jobs.
    const selections = matrixRows(config.strategy?.matrix) ?? [{}]
    for (const row of selections) {
      const labels: unknown[] = []
      const append = (value: unknown): void => {
        if (Array.isArray(value) === true) {
          for (const item of value) append(item)
          return
        }
        const reference =
          typeof value === 'string' ? /^\$\{\{\s*matrix\.([\w.-]+)\s*\}\}$/.exec(value) : null
        if (reference !== null) {
          let resolved: unknown = row
          for (const key of reference[1]!.split('.'))
            resolved =
              typeof resolved === 'object' && resolved !== null
                ? Reflect.get(resolved, key)
                : undefined
          if (Array.isArray(resolved) === true) labels.push(...resolved)
          else labels.push(resolved)
        } else {
          const output = policy.admittedRunnerOutputs?.find(
            (candidate) => candidate.expression === value,
          )
          const exclusive = output?.labels.find(
            (label) => policy.exclusiveRunnerLabels?.includes(label) === true,
          )
          labels.push(exclusive ?? value)
          // JSON outputs may select multiple labels; a mixed exclusive contract is unsafe.
          if (
            exclusive !== undefined &&
            typeof value === 'string' &&
            value.includes('fromJSON(') === true &&
            output !== undefined &&
            output.labels.length > 1
          )
            add({ job, rule: 'runner-label-mix', path, value })
        }
      }
      append(config['runs-on'])
      if (
        labels.length > 1 &&
        labels.some(
          (label) =>
            typeof label === 'string' && policy.exclusiveRunnerLabels?.includes(label) === true,
        ) === true
      )
        add({ job, rule: 'runner-label-mix', path, value: JSON.stringify(labels) })
    }
    for (const [index, step] of config.steps.entries()) {
      if ('uses' in step === false) continue
      const stepPath = `jobs.${job}.steps[${index}]`
      if (
        policy.bannedActions?.some((action) => matchesAction({ uses: step.uses, action })) === true
      )
        add({ job, rule: 'banned-action', path: `${stepPath}.uses`, value: step.uses })
      for (const cache of policy.setupActionCaches ?? []) {
        if (matchesAction({ uses: step.uses, action: cache.action }) === false) continue
        const major = /^v(\d+)(?:\.\d+){0,2}$/.exec(step.uses.split('@')[1] ?? '')
        if (
          cache.minimumMajor !== undefined &&
          major !== null &&
          Number(major[1]) < cache.minimumMajor
        )
          continue
        const value = step.with?.[cache.input]
        const enabled =
          cache.enabledUnless !== undefined
            ? value === undefined || String(value).trim().toLowerCase() !== cache.enabledUnless
            : value === undefined
              ? cache.defaultEnabled
              : value !== false &&
                String(value).trim() !== '' &&
                String(value).trim().toLowerCase() !== 'false'
        if (enabled === true)
          add({
            job,
            rule: 'setup-action-cache',
            path: `${stepPath}.with.${cache.input}`,
            value: value === undefined ? '(default enabled)' : String(value),
          })
      }
      if (
        policy.banDockerGhaCache !== false &&
        matchesAction({ uses: step.uses, action: 'docker/build-push-action' }) === true
      ) {
        for (const input of ['cache-from', 'cache-to']) {
          const value = step.with?.[input]
          if (
            value !== undefined &&
            /(?:^|[\s,])type\s*=\s*gha(?:$|[\s,])/i.test(String(value)) === true
          )
            add({
              job,
              rule: 'docker-gha-cache',
              path: `${stepPath}.with.${input}`,
              value: String(value),
            })
        }
      }
    }
  }
  return violations
}

const violationKey = (violation: WorkflowPolicyViolation): string =>
  JSON.stringify([
    violation.repository,
    violation.workflow,
    violation.job,
    violation.rule,
    violation.path,
    violation.value,
  ])
const exceptionKey = (
  entry: Pick<WorkflowPolicyViolation, 'repository' | 'workflow' | 'job' | 'rule'>,
): string => JSON.stringify([entry.repository, entry.workflow, entry.job, entry.rule])

/** Validate policy/exception provenance and collect the unsuppressed observations used by checks and ledgers. */
export const collectEffectiveWorkflowPolicyViolations = ({
  workflow,
  policy,
}: {
  workflow: GitHubWorkflowArgs
  policy: WorkflowPolicy
}): WorkflowPolicyViolation[] => {
  const issues: WorkflowPolicyIssue[] = []
  if (policy.repository.trim() === '' || policy.workflow.trim() === '')
    issues.push({
      kind: 'INVALID_POLICY',
      message: 'Policy requires exact repository and workflow identities.',
    })
  const today = new Date().toISOString().slice(0, 10)
  const accepted = new Set<string>()
  for (const exception of policy.exceptions ?? []) {
    const date = new Date(`${exception.expiry}T00:00:00.000Z`)
    const key = exceptionKey(exception)
    const valid =
      exception.repository === policy.repository &&
      exception.workflow === policy.workflow &&
      (exception.job === '*'
        ? exception.rule === 'pull-request-target'
        : exception.job.trim() !== '') &&
      rules.includes(exception.rule) === true &&
      neverExceptable[exception.rule] !== true &&
      policy.neverExceptableRules?.includes(exception.rule) !== true &&
      [exception.owner, exception.approver, exception.justification, exception.trackingIssue].every(
        (value) => typeof value === 'string' && value.trim() !== '',
      ) === true &&
      /^\d{4}-\d{2}-\d{2}$/.test(exception.expiry) === true &&
      Number.isNaN(date.getTime()) === false &&
      date.toISOString().slice(0, 10) === exception.expiry &&
      exception.expiry >= today &&
      accepted.has(key) === false
    if (valid === true) accepted.add(key)
    else
      issues.push({
        kind: 'INVALID_EXCEPTION',
        message: `Invalid, expired, duplicate, or forbidden exception: ${key}`,
      })
  }
  if (issues.length > 0) throw new WorkflowPolicyError(issues)
  return collectWorkflowPolicyViolations({ workflow, policy }).filter(
    (violation) => accepted.has(exceptionKey(violation)) === false,
  )
}

/** Enforce policy or compare its effective observations with the exact report ledger. */
export const validateWorkflowPolicy = ({
  workflow,
  policy,
}: {
  workflow: GitHubWorkflowArgs
  policy: WorkflowPolicy
}): void => {
  const violations = collectEffectiveWorkflowPolicyViolations({ workflow, policy })
  const issues: WorkflowPolicyIssue[] = []
  if (policy.mode === 'report') {
    const actual = new Set(violations.map(violationKey))
    const expected = new Set((policy.ledger ?? []).map(violationKey))
    for (const violation of violations)
      if (expected.has(violationKey(violation)) === false)
        issues.push({ kind: 'NEW', message: violationKey(violation), violation })
    for (const violation of policy.ledger ?? [])
      if (actual.has(violationKey(violation)) === false)
        issues.push({ kind: 'STALE', message: violationKey(violation), violation })
  } else {
    for (const violation of violations)
      issues.push({ kind: 'VIOLATION', message: violationKey(violation), violation })
  }
  if (issues.length > 0) throw new WorkflowPolicyError(issues)
}
