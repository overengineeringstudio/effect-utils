import { pinnedActionVersion } from './action-pins.ts'
import type { GitHubWorkflowArgs } from './mod.ts'
import { workflowPolicyStepIdentity } from './policy-step-identity.ts'

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
  | 'fleet-pr-without-same-repo-guard'
  | 'fork-controlled-runner'

/** Stable, exact identity for an observed violation and its report-mode ledger entry. */
export type WorkflowPolicyViolation = {
  readonly repository: string
  readonly workflow: string
  readonly job: string
  readonly rule: WorkflowPolicyRule
  readonly path: string
  /** Observed diagnostic value; banned-action identity excludes the action ref. */
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
  /** Runner labels whose fork-capable event jobs require the canonical same-repository guard. */
  readonly sameRepoGuardRunnerLabels?: readonly string[]
  /** These labels must be the only label in an individual runner selection. */
  readonly exclusiveRunnerLabels?: readonly string[]
  readonly bannedHostedRunners?: boolean
  readonly bannedNamespaceRunners?: boolean
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
  readonly kind: 'VIOLATION' | 'NEW' | 'INVALID_EXCEPTION' | 'INVALID_POLICY'
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
  'fleet-pr-without-same-repo-guard',
  'fork-controlled-runner',
]
const neverExceptable: Partial<Record<WorkflowPolicyRule, true>> = {
  'hosted-runner': true,
  'namespace-runner': true,
  'pull-request-target': true,
  'banned-action': true,
  'setup-action-cache': true,
  'docker-gha-cache': true,
  'runner-fallback': true,
  'runner-label-mix': true,
  'fleet-pr-without-same-repo-guard': true,
  'fork-controlled-runner': true,
}

const guardEvents = {
  trusted: ['push', 'merge_group', 'schedule', 'workflow_dispatch'],
  pullRequest: ['pull_request', 'pull_request_review', 'pull_request_review_comment'],
  upstreamRun: ['workflow_run'],
} as const
const isTrustedWorkflowEvent = (event: string): boolean =>
  guardEvents.trusted.some((trusted) => trusted === event)
const eventCondition = (events: readonly string[]): string =>
  events.map((event) => `github.event_name == '${event}'`).join(' || ')
const sameRepoGuardExpression =
  `(${eventCondition(guardEvents.trusted)}) || ` +
  `((${eventCondition(guardEvents.pullRequest)}) && github.event.pull_request.head.repo.full_name == github.repository) || ` +
  `(${eventCondition(guardEvents.upstreamRun)} && github.event.workflow_run.head_repository.full_name == github.repository)`

const expressionProperty = ({ value, key }: { value: unknown; key: string }): unknown => {
  if (typeof value !== 'object' || value === null) return undefined
  const actual = Object.keys(value).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  )
  return actual === undefined ? undefined : Reflect.get(value, actual)
}

/** Immutable run/repository identity, not PR payload, branch, input, or environment data.
 * workflow is the checked-in workflow name; repository/owner identify the executing
 * repository; run IDs/counters are assigned by GitHub rather than fork authors.
 */
const safeGithubRunnerProperties: Readonly<Record<string, true>> = {
  repository: true,
  repository_owner: true,
  run_id: true,
  run_number: true,
  run_attempt: true,
  workflow: true,
}
const safeRunnerFunctions: Readonly<Record<string, true>> = {
  format: true,
  fromjson: true,
  tojson: true,
  contains: true,
  startswith: true,
  endswith: true,
  join: true,
}

const hasUnadmittedRunnerTokens = ({
  expression,
  admittedOutput,
  matrixReference,
}: {
  expression: string
  admittedOutput: boolean
  matrixReference?: ((path: readonly string[]) => boolean) | undefined
}): boolean => {
  const tokens = expression.toLowerCase().match(/[a-z_][\w-]*|[.[\]()]/g) ?? []
  for (let index = 0; index < tokens.length; index++) {
    const root = tokens[index]!
    if (/^[a-z_]/.test(root) === false) continue
    if (tokens[index + 1] === '(') {
      if (safeRunnerFunctions[root] !== true) return true
      continue
    }
    const path = [root]
    while (tokens[index + 1] === '.') {
      const property = tokens[index + 2]
      if (property === undefined || /^[a-z_]/.test(property) === false) return true
      path.push(property)
      index += 2
    }
    if (tokens[index + 1] === '[') return true
    if (path.length === 1 && ['true', 'false', 'null'].includes(root) === true) continue
    if (root === 'vars' && path.length >= 2) continue
    if (root === 'matrix' && path.length >= 2 && matrixReference?.(path.slice(1)) === true) continue
    if (root === 'needs' && admittedOutput === true && path.length === 4 && path[2] === 'outputs')
      continue
    if (root === 'github' && path.length === 2 && safeGithubRunnerProperties[path[1]!] === true)
      continue
    return true
  }
  return false
}

/** Scan expression boundaries without treating quoted braces as closing delimiters. */
const hasForkControlledRunnerExpression = ({
  value,
  admittedOutput = false,
  matrixReference,
}: {
  value: string
  admittedOutput?: boolean
  matrixReference?: ((path: readonly string[]) => boolean) | undefined
}): boolean => {
  let offset = 0
  while (offset < value.length) {
    const start = value.indexOf('${{', offset)
    if (start === -1) return false
    let quoted = false
    let closed = false
    let expression = ''
    for (let index = start + 3; index < value.length; index++) {
      const char = value[index]!
      if (char === "'") {
        if (quoted === true && value[index + 1] === "'") {
          index++
          continue
        }
        quoted = !quoted
        expression += ' '
      } else if (quoted === false) {
        if (char === '}' && value[index + 1] === '}') {
          offset = index + 2
          closed = true
          break
        }
        expression += char
      }
    }
    // Malformed expressions cannot establish safe runner provenance either.
    if (closed === false || quoted === true) return true
    if (hasUnadmittedRunnerTokens({ expression, admittedOutput, matrixReference }) === true)
      return true
  }
  return false
}

/** A matrix context token carries the provenance of its referenced axis and row modifiers.
 * Dynamic sources may use trusted configuration/identity or exact admitted outputs,
 * never another matrix reference (which would make provenance circular).
 */
const admittedRunnerMatrixReference = ({
  path,
  matrix,
  policy,
}: {
  path: readonly string[]
  matrix: unknown
  policy: WorkflowPolicy
}): boolean => {
  const admittedSource = (value: unknown): boolean => {
    if (typeof value === 'string' && value.includes('${{') === true)
      return (
        hasForkControlledRunnerExpression({
          value,
          admittedOutput:
            outputExpression.test(value) === true &&
            policy.admittedRunnerOutputs?.some((output) => output.expression === value) === true,
        }) === false
      )
    if (Array.isArray(value) === true) return value.every(admittedSource)
    if (typeof value === 'object' && value !== null)
      return Object.values(value).every(admittedSource)
    return value !== undefined
  }
  if (typeof matrix === 'string')
    return matrix.includes('${{') === true && admittedSource(matrix) === true
  if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix) === true) return false
  const axis = expressionProperty({ value: matrix, key: path[0]! })
  const resolvesPath = (value: unknown): boolean => {
    for (const key of path.slice(1)) {
      if (typeof value === 'string' && value.includes('${{') === true) return admittedSource(value)
      value = expressionProperty({ value, key })
    }
    return value !== undefined && admittedSource(value) === true
  }
  let found = false
  if (axis !== undefined) {
    if (typeof axis === 'string' && axis.includes('${{') === true) {
      if (admittedSource(axis) === false) return false
      found = true
    } else {
      if (Array.isArray(axis) === false || axis.length === 0 || axis.every(resolvesPath) === false)
        return false
      found = true
    }
  }
  for (const modifier of ['include', 'exclude']) {
    const rows = expressionProperty({ value: matrix, key: modifier })
    if (rows === undefined) continue
    if (admittedSource(rows) === false) return false
    if (typeof rows === 'string' && rows.includes('${{') === true) {
      if (modifier === 'include') found = true
      continue
    }
    if (Array.isArray(rows) === false) return false
    if (modifier === 'include') {
      for (const row of rows) {
        if (typeof row === 'string' && row.includes('${{') === true) {
          found = true
          continue
        }
        if (typeof row !== 'object' || row === null || Array.isArray(row) === true) return false
        const value = expressionProperty({ value: row, key: path[0]! })
        if (value === undefined) continue
        if (resolvesPath(value) === false) return false
        found = true
      }
    }
  }
  return found
}

/** Canonical allowlist: reusable workflows inherit the caller's event and context.
 * Unknown and issue/comment/target events are denied, never implicitly trusted.
 */
export const sameRepoPullRequestGuard = (): string => sameRepoGuardExpression

/** Scan only actual top-level operators; quoted strings and nested expressions cannot attest a guard. */
const guardExpressionParts = (expression: string) => {
  const delimiters: string[] = []
  let quote = ''
  let start = 0
  let outerClose = -1
  let hasOr = false
  const parts: string[] = []
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]!
    if (quote !== '') {
      if (char === quote) {
        if (expression[index + 1] === quote) index++
        else quote = ''
      }
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '(' || char === '[') delimiters.push(char)
    else if (char === ')' || char === ']') {
      if (delimiters.pop() !== (char === ')' ? '(' : '[')) return undefined
      if (char === ')' && delimiters.length === 0 && outerClose === -1) outerClose = index
    } else if (delimiters.length === 0 && expression.slice(index, index + 2) === '||') {
      hasOr = true
      index++
    } else if (delimiters.length === 0 && expression.slice(index, index + 2) === '&&') {
      parts.push(expression.slice(start, index).trim())
      index++
      start = index + 1
    }
  }
  if (delimiters.length !== 0 || quote !== '') return undefined
  parts.push(expression.slice(start).trim())
  return { parts, hasOr, outerClose }
}

const unwrapGuardExpression = (value: string): string => {
  let expression = value.trim()
  while (expression.startsWith('(') === true) {
    if (guardExpressionParts(expression)?.outerClose !== expression.length - 1) break
    expression = expression.slice(1, -1).trim()
  }
  return expression
}

const hasSameRepoPullRequestGuard = (condition: string | undefined): boolean => {
  if (condition === undefined) return false
  const trimmed = condition.trim()
  const expression = unwrapGuardExpression(
    trimmed.startsWith('${{') === true && trimmed.endsWith('}}') === true
      ? trimmed.slice(3, -2)
      : trimmed,
  )
  const guard = sameRepoPullRequestGuard()
  if (expression === guard) return true
  const parsed = guardExpressionParts(expression)
  return (
    parsed !== undefined &&
    parsed.hasOr === false &&
    parsed.parts.length > 1 &&
    parsed.parts.every((part) => part !== '') === true &&
    parsed.parts.some((part) => unwrapGuardExpression(part) === guard) === true
  )
}

/** Split only top-level conjunctions; nested/quoted operators cannot supply a proof. */
export const workflowConditionConjuncts = (condition: string): readonly string[] | undefined => {
  const parsed = guardExpressionParts(unwrapGuardExpression(condition))
  if (
    parsed === undefined ||
    parsed.hasOr === true ||
    parsed.parts.some((part) => part === '') === true
  )
    return undefined
  return parsed.parts.map(unwrapGuardExpression)
}

/** Remove only the exact canonical guard when it is a top-level conjunction.
 * The guard only narrows admission, so proofs about the remaining restriction still hold.
 * Unrecognized/modified guards and outer disjunctions are returned untouched.
 */
export const stripSameRepoPullRequestGuard = (condition: string): string => {
  const expression = unwrapGuardExpression(condition)
  const parsed = guardExpressionParts(expression)
  if (
    parsed === undefined ||
    parsed.hasOr === true ||
    parsed.parts.length < 2 ||
    parsed.parts.some((part) => part === '') === true
  )
    return condition
  const guard = sameRepoPullRequestGuard()
  const remaining = parsed.parts.filter((part) => unwrapGuardExpression(part) !== guard)
  if (remaining.length === parsed.parts.length) return condition
  return unwrapGuardExpression(remaining.join(' && '))
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
  const protectedRunnerJobs = new Set<string>()
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
    if (policy.sameRepoGuardRunnerLabels?.includes(label) === true) protectedRunnerJobs.add(job)
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
  if (events.includes('pull_request_target') === true)
    add({
      job: '*',
      rule: 'pull-request-target',
      path: 'on.pull_request_target',
      value: 'pull_request_target',
    })
  for (const [job, config] of Object.entries(workflow.jobs)) {
    const path = `jobs.${job}.runs-on`
    const protectUnknown = (): void => {
      if (policy.sameRepoGuardRunnerLabels !== undefined) protectedRunnerJobs.add(job)
    }
    const checkRunner = ({
      runner,
      resolveMatrix,
    }: {
      runner: unknown
      resolveMatrix: boolean
    }): void => {
      if (typeof runner === 'object' && runner !== null && Array.isArray(runner) === false) {
        const labels: unknown = Reflect.get(runner, 'labels')
        const group: unknown = Reflect.get(runner, 'group')
        if (labels !== undefined) checkRunner({ runner: labels, resolveMatrix })
        else protectUnknown()
        if (
          typeof group === 'string' &&
          events.some((event) => isTrustedWorkflowEvent(event) === false) === true &&
          hasForkControlledRunnerExpression({
            value: group,
            matrixReference: (reference) =>
              admittedRunnerMatrixReference({
                path: reference,
                matrix: config.strategy?.matrix,
                policy,
              }),
          }) === true
        )
          add({ job, rule: 'fork-controlled-runner', path, value: group })
        return
      }
      if (Array.isArray(runner) === true) {
        if (runner.length === 0) {
          protectUnknown()
          add({ job, rule: 'dynamic-runner', path, value: '[]' })
        }
        for (const label of runner) checkRunner({ runner: label, resolveMatrix })
        return
      }
      if (typeof runner !== 'string' || runner.length === 0) {
        protectUnknown()
        add({ job, rule: 'dynamic-runner', path, value: String(runner) })
        return
      }
      if (runner.includes('${{') === false) {
        labelRules({ job, path, label: runner })
        if (
          policy.sameRepoGuardRunnerLabels !== undefined &&
          policy.admittedRunnerLabels.includes(runner) === false &&
          /^(?:ubuntu-|macos-|windows-|namespace-profile-|nscloud-|namespace-features:)/i.test(
            runner,
          ) === false
        )
          protectUnknown()
        return
      }
      // Even unresolved expressions must not hide forbidden literal fallbacks.
      const fixedNonFleetPrefix =
        /^(?:ubuntu-|macos-|windows-|namespace-profile-|nscloud-|namespace-features:)/i.test(runner)
      if (
        fixedNonFleetPrefix === false &&
        events.some((event) => isTrustedWorkflowEvent(event) === false) === true &&
        hasForkControlledRunnerExpression({
          value: runner,
          matrixReference: (reference) =>
            admittedRunnerMatrixReference({
              path: reference,
              matrix: config.strategy?.matrix,
              policy,
            }),
          admittedOutput:
            outputExpression.test(runner) === true &&
            policy.admittedRunnerOutputs?.some((output) => output.expression === runner) === true,
        }) === true
      )
        add({ job, rule: 'fork-controlled-runner', path, value: runner })
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
      const reference = /^\$\{\{\s*matrix\.([\w.-]+)\s*\}\}$/i.exec(runner)
      if (resolveMatrix === true && reference !== null) {
        const rows = matrixRows(config.strategy?.matrix)
        if (rows !== undefined && rows.length > 0) {
          for (const row of rows) {
            let value: unknown = row
            for (const key of reference[1]!.split('.')) value = expressionProperty({ value, key })
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
          if (
            /^(?:ubuntu-|macos-|windows-|namespace-profile-|nscloud-|namespace-features:)/i.test(
              label,
            ) === false
          )
            protectUnknown()
          if (label.includes('${{') === true)
            add({ job, rule: 'dynamic-runner', path, value: label })
          else labelRules({ job, path, label })
        }
        return
      }
      if (fixedNonFleetPrefix === false) protectUnknown()
      add({ job, rule: 'dynamic-runner', path, value: runner })
    }
    checkRunner({ runner: config['runs-on'], resolveMatrix: true })
    if (
      protectedRunnerJobs.has(job) === true &&
      events.some((event) => isTrustedWorkflowEvent(event) === false) === true &&
      hasSameRepoPullRequestGuard(config.if) === false
    ) {
      add({
        job,
        rule: 'fleet-pr-without-same-repo-guard',
        path: `jobs.${job}.if`,
        value: config.if ?? '(missing)',
      })
    }
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
          typeof value === 'string' ? /^\$\{\{\s*matrix\.([\w.-]+)\s*\}\}$/i.exec(value) : null
        if (reference !== null) {
          let resolved: unknown = row
          for (const key of reference[1]!.split('.'))
            resolved = expressionProperty({ value: resolved, key })
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
    const stepOrdinals = new Map<string, number>()
    for (const step of config.steps) {
      const identity = workflowPolicyStepIdentity({ step, ordinals: stepOrdinals })
      if ('uses' in step === false) continue
      const stepPath = `jobs.${job}.steps[${identity}]`
      if (
        policy.bannedActions?.some((action) => matchesAction({ uses: step.uses, action })) === true
      )
        add({ job, rule: 'banned-action', path: `${stepPath}.uses`, value: step.uses })
      for (const cache of policy.setupActionCaches ?? []) {
        if (matchesAction({ uses: step.uses, action: cache.action }) === false) continue
        const ref = step.uses.split('@')[1] ?? ''
        const version = /^[0-9a-f]{40}$/i.test(ref) === true ? pinnedActionVersion(step.uses) : ref
        if (cache.minimumMajor !== undefined && version === undefined) {
          add({
            job,
            rule: 'setup-action-cache',
            path: `${stepPath}.uses`,
            value: 'Unknown SHA-pinned action version; register its verified release in actionPins',
          })
          continue
        }
        const major = /^v(\d+)(?:\.\d+){0,2}$/.exec(version ?? '')
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
    violation.rule === 'banned-action' ? violation.value.split('@')[0] : violation.value,
  ])
const exceptionKey = (
  entry: Pick<WorkflowPolicyViolation, 'repository' | 'workflow' | 'job' | 'rule'>,
): string => JSON.stringify([entry.repository, entry.workflow, entry.job, entry.rule])

const contentKey = (entry: WorkflowPolicyViolation): string | undefined => {
  if (entry.rule !== 'banned-action') return undefined
  const prefix = `jobs.${entry.job}.steps[`
  if (entry.path.startsWith(prefix) === false) return undefined
  const identity = /^(?:id|name):"(?:[^"\\]|\\.)*"\|action:"(?:[^"\\]|\\.)*"\|content:/.exec(
    entry.path.slice(prefix.length),
  )?.[0]
  return identity === undefined
    ? undefined
    : JSON.stringify([
        entry.repository,
        entry.workflow,
        entry.job,
        entry.rule,
        entry.value.split('@')[0],
        identity,
      ])
}
/**
 * Refresh only content-addressed, labelled banned-action steps. The existing id
 * (preferred) or name survives unrelated step insertion; unlabelled steps cannot
 * prove identity. Action refs remain diagnostic-only, as in ordinary ledger keys.
 */
export const reconcileWorkflowPolicyLedger = ({
  violations,
  ledger,
  refresh = false,
}: {
  readonly violations: readonly WorkflowPolicyViolation[]
  readonly ledger: readonly WorkflowPolicyViolation[]
  readonly refresh?: boolean
}): readonly WorkflowPolicyViolation[] => {
  const remaining = new Set(ledger)
  const issues: WorkflowPolicyIssue[] = []
  const result = violations.map((violation) => {
    const exact = [...remaining].find((entry) => violationKey(entry) === violationKey(violation))
    if (exact !== undefined) {
      remaining.delete(exact)
      return exact
    }
    const key = contentKey(violation)
    const candidates = key === undefined ? [] : ledger.filter((entry) => contentKey(entry) === key)
    if (candidates.length > 0) {
      const ambiguous =
        candidates.length !== 1 ||
        violations.filter((entry) => contentKey(entry) === key).length !== 1 ||
        remaining.has(candidates[0]!) === false
      if (ambiguous === true)
        issues.push({
          kind: 'NEW',
          message: `Ambiguous banned-action re-key in ${violation.repository}/${violation.workflow}/${violation.job}: step identity must match one ledger row and one current finding.`,
          violation,
        })
      else if (refresh === true) {
        const previous = candidates[0]!
        remaining.delete(previous)
        return { ...previous, path: violation.path }
      } else
        issues.push({
          kind: 'NEW',
          message: `${violationKey(violation)}; step content changed. Review a ledger refresh with devenv tasks run genie:run.`,
          violation,
        })
    } else issues.push({ kind: 'NEW', message: violationKey(violation), violation })
    return violation
  })
  if (issues.length > 0) throw new WorkflowPolicyError(issues)
  return result
}

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

/** Enforce policy or reject new report-mode debt. Generated ledger freshness detects removals. */
export const validateWorkflowPolicy = ({
  workflow,
  policy,
  refreshLedger = false,
}: {
  workflow: GitHubWorkflowArgs
  policy: WorkflowPolicy
  /** Construction may defer content-only re-keys until stringify knows the run mode. */
  refreshLedger?: boolean
}): void => {
  const violations = collectEffectiveWorkflowPolicyViolations({ workflow, policy })
  const issues: WorkflowPolicyIssue[] = []
  for (const violation of violations) {
    if (
      policy.mode === 'report' &&
      (violation.rule === 'fleet-pr-without-same-repo-guard' ||
        violation.rule === 'pull-request-target' ||
        violation.rule === 'fork-controlled-runner')
    ) {
      issues.push({ kind: 'VIOLATION', message: violationKey(violation), violation })
    }
  }
  if (policy.mode === 'report') {
    reconcileWorkflowPolicyLedger({
      violations,
      ledger: policy.ledger ?? [],
      refresh: refreshLedger,
    })
  } else {
    for (const violation of violations)
      issues.push({ kind: 'VIOLATION', message: violationKey(violation), violation })
  }
  if (issues.length > 0) throw new WorkflowPolicyError(issues)
}
