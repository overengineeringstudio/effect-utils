import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/github-workflow/mod.ts'
import {
  validateWorkflowPolicy,
  WorkflowPolicyError,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import type {
  WorkflowPolicyException,
  WorkflowPolicyIssue,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import { fleetWorkflowPolicy, validateFleetPolicyExceptionRegistry } from './policy.ts'

/** Parse at the YAML boundary; policy decisions remain entirely in the shared validator. */
const readWorkflow = async (path: string): Promise<GitHubWorkflowArgs> => {
  // Bun's YAML decoder is also used by the workflow integration tests. The typed
  // boundary below is checked structurally before the policy engine sees it.
  const workflow: GitHubWorkflowArgs = Bun.YAML.parse(await Bun.file(path).text())
  if (
    typeof workflow !== 'object' ||
    workflow === null ||
    Array.isArray(workflow) ||
    (typeof workflow.on !== 'string' &&
      (Array.isArray(workflow.on)
        ? workflow.on.every((event) => typeof event === 'string') === false
        : typeof workflow.on !== 'object' || workflow.on === null)) ||
    typeof workflow.jobs !== 'object' ||
    workflow.jobs === null ||
    Array.isArray(workflow.jobs) ||
    Object.keys(workflow.jobs).length === 0
  )
    throw new Error(`${path}: expected workflow triggers and nonempty jobs`)
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (typeof job !== 'object' || job === null || Array.isArray(job.steps) === false)
      throw new Error(
        `${path}: jobs.${id} must declare steps; reusable workflow calls are not admitted`,
      )
    const runner: unknown = job['runs-on']
    const labels = (value: unknown): boolean =>
      (typeof value === 'string' && value.trim() !== '') ||
      (Array.isArray(value) &&
        value.length > 0 &&
        value.every((label) => typeof label === 'string' && label.trim() !== ''))
    const runnerMapping =
      typeof runner === 'object' &&
      runner !== null &&
      Array.isArray(runner) === false &&
      Object.keys(runner).length > 0 &&
      Object.keys(runner).every((key) => key === 'labels' || key === 'group') &&
      ('labels' in runner ? labels(runner.labels) : true) &&
      ('group' in runner ? typeof runner.group === 'string' && runner.group.trim() !== '' : true)
    if (labels(runner) === false && runnerMapping === false)
      throw new Error(`${path}: jobs.${id}.runs-on has an unsupported runner shape`)
    const condition: unknown = job.if
    if (typeof condition === 'boolean' || typeof condition === 'number') job.if = String(condition)
    else if (condition !== undefined && typeof condition !== 'string')
      throw new Error(`${path}: jobs.${id}.if must be a scalar expression`)
    for (const step of job.steps) {
      if (
        typeof step !== 'object' ||
        step === null ||
        Array.isArray(step) ||
        'uses' in step === 'run' in step ||
        ('uses' in step && (typeof step.uses !== 'string' || step.uses.trim() === '')) ||
        ('run' in step && (typeof step.run !== 'string' || step.run.trim() === ''))
      )
        throw new Error(`${path}: jobs.${id} has an invalid step`)
    }
  }
  return workflow
}

/** Enforce the fleet policy over the complete consumer workflow census. */
export const checkPolicy = async ({
  root,
  repository,
  exceptionsFile,
}: {
  readonly root: string
  readonly repository: string
  readonly exceptionsFile?: string
}): Promise<readonly WorkflowPolicyIssue[]> => {
  const directory = join(root, '.github/workflows')
  const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort()
  if (files.length === 0) throw new Error(`${directory}: no workflow YAML files found`)
  const workflows = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        `.github/workflows/${file}`,
        await readWorkflow(join(directory, file)),
      ]),
    ),
  )
  const exceptionEntries: readonly WorkflowPolicyException[] =
    exceptionsFile === undefined
      ? []
      : (await Bun.file(resolve(root, exceptionsFile)).json()).exceptions
  if (
    Array.isArray(exceptionEntries) === false ||
    exceptionEntries.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        entry.repository !== repository ||
        [
          'workflow',
          'job',
          'rule',
          'owner',
          'approver',
          'justification',
          'expiry',
          'trackingIssue',
        ].some((key) => typeof Reflect.get(entry, key) !== 'string'),
    )
  )
    throw new Error('Exceptions must contain exact identities and provenance for this repository')
  const issues: WorkflowPolicyIssue[] = []
  const collect = (run: () => void): void => {
    try {
      run()
    } catch (error) {
      if (error instanceof WorkflowPolicyError) issues.push(...error.issues)
      else throw error
    }
  }
  collect(() => validateFleetPolicyExceptionRegistry({ repository, workflows, exceptionEntries }))
  for (const [workflow, value] of Object.entries(workflows))
    collect(() =>
      validateWorkflowPolicy({
        workflow: value,
        policy: fleetWorkflowPolicy({ repository, workflow, mode: 'enforce', exceptionEntries }),
      }),
    )
  return issues
}

if (import.meta.main) {
  try {
    const [root, repository, exceptionsFile] = process.argv.slice(2)
    if (root === undefined || repository === undefined)
      throw new Error(
        'Usage: check-policy.ts <repository-root> <owner/repository> [exceptions.json]',
      )
    const issues = await checkPolicy({
      root,
      repository,
      exceptionsFile: exceptionsFile || undefined,
    })
    for (const issue of issues) console.error(`${issue.kind}: ${issue.message}`)
    if (issues.length > 0) process.exitCode = 1
    else console.log('CI workflow fleet policy passed')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
