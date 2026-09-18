import { readFileSync } from 'node:fs'
import process from 'node:process'

import {
  authoritativeBuck2TypeScriptDeclarations,
  authoritativeBuck2TypeScriptProjects,
  type AuthoritativeBuck2TypeScriptDeclaration,
  type AuthoritativeBuck2TypeScriptProject,
} from './typescript-admissions.ts'

export type ProducerOperation = 'dist' | 'typecheck'

export type ProducerOverlapAllowance = {
  readonly ledgerRow: `effect-utils/${ProducerOperation}/${string}`
  readonly operation: ProducerOperation
  readonly packagePath: string
}

export type ProducerOverlap = {
  readonly operation: ProducerOperation
  readonly packagePath: string
  readonly producers: readonly [buck: string, legacy: string]
}

/** Lower stack members retired every prior allowance with the root TypeScript solution. */
export const producerOverlapAllowlist: readonly ProducerOverlapAllowance[] = []

const overlapKey = ({
  operation,
  packagePath,
}: Pick<ProducerOverlap, 'operation' | 'packagePath'>): string => `${operation}:${packagePath}`

export const findProducerOverlaps = ({
  projects,
  declarations,
  allowances,
  devenvTaskNames,
}: {
  readonly projects: readonly AuthoritativeBuck2TypeScriptProject[]
  readonly declarations: readonly AuthoritativeBuck2TypeScriptDeclaration[]
  readonly allowances: readonly ProducerOverlapAllowance[]
  readonly devenvTaskNames: readonly string[]
}): readonly ProducerOverlap[] => {
  const taskNames = new Set(devenvTaskNames)
  const overlaps: ProducerOverlap[] = []

  if (taskNames.has('ts:check')) {
    overlaps.push(
      ...projects.map(
        (project): ProducerOverlap => ({
          operation: 'typecheck',
          packagePath: project.packagePath,
          producers: [`Buck ${project.typecheckTarget}`, 'devenv ts:check'],
        }),
      ),
    )
  }
  if (taskNames.has('ts:emit')) {
    overlaps.push(
      ...declarations.map(
        (declaration): ProducerOverlap => ({
          operation: 'dist',
          packagePath: declaration.packagePath,
          producers: [`Buck ${declaration.distTarget}`, 'devenv ts:emit'],
        }),
      ),
    )
  }

  const overlapKeys = new Set(overlaps.map(overlapKey))
  const staleAllowances = allowances.filter(
    (allowance) => overlapKeys.has(overlapKey(allowance)) === false,
  )
  if (staleAllowances.length > 0) {
    throw new Error(
      `stale Buck producer overlap allowances: ${staleAllowances.map(({ ledgerRow }) => ledgerRow).join(', ')}`,
    )
  }

  const allowedKeys = new Set(allowances.map(overlapKey))
  return overlaps.filter((overlap) => allowedKeys.has(overlapKey(overlap)) === false)
}

const taskNamesFromDocument = (document: unknown): readonly string[] => {
  if (Array.isArray(document)) {
    return document.flatMap((task) =>
      task !== null && typeof task === 'object' && 'name' in task && typeof task.name === 'string'
        ? [task.name]
        : [],
    )
  }
  if (document === null || typeof document !== 'object') return []
  const tasks = 'tasks' in document ? document.tasks : document
  if (Array.isArray(tasks)) return taskNamesFromDocument(tasks)
  if (tasks === null || typeof tasks !== 'object') return []
  return Object.entries(tasks).flatMap(([key, task]) =>
    task !== null && typeof task === 'object' && 'name' in task && typeof task.name === 'string'
      ? [task.name]
      : [key],
  )
}

const main = (): number => {
  const [operation, taskDocumentPath, ...unexpected] = process.argv.slice(2)
  if (operation !== 'check' || taskDocumentPath === undefined || unexpected.length > 0) {
    console.error('usage: producer-overlap.ts check <devenv-task-document>')
    return 2
  }

  const taskDocument: unknown = JSON.parse(readFileSync(taskDocumentPath, 'utf8'))
  const overlaps = findProducerOverlaps({
    projects: authoritativeBuck2TypeScriptProjects,
    declarations: authoritativeBuck2TypeScriptDeclarations,
    allowances: producerOverlapAllowlist,
    devenvTaskNames: taskNamesFromDocument(taskDocument),
  })
  if (overlaps.length === 0) return 0
  for (const overlap of overlaps) {
    console.error(
      `${overlap.packagePath} ${overlap.operation} has overlapping producers: ${overlap.producers.join(', ')}`,
    )
  }
  return 1
}

if (import.meta.main === true) process.exit(main())
