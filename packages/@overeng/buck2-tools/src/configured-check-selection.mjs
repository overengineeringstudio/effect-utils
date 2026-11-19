#!/usr/bin/env bun
// JS-runtime adapter for the existing ownership and reverse-package authorities.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { affectedPackagePaths, buildTargetsFor, selectConfiguredChecks } from './buck-watch.ts'
import { parseBuckOwnershipQuery, requireRepositoryRelativePath } from './owned-files.ts'

const canonical = (value) => JSON.stringify(value, (_key, entry) =>
  entry !== null && typeof entry === 'object' && Array.isArray(entry) === false
    ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : entry)
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex')

/** Collect a source-pinned configured inventory, dependency graphs, and reverse ownership closure. */
export const collectConfiguredSnapshot = ({ revision, root, buck2, buckArgs = [], queryArgs = [],
  requiredQuery, universeQuery, changedPaths, scratch,
  watchPlan = { globalPaths: [], packages: [] } }) => {
  const run = ({ command, args }) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
      timeout: 120000 })
    if (result.error !== undefined || result.status !== 0)
      throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
    return result.stdout
  }
  if (run({ command: 'git', args: ['rev-parse', 'HEAD'] }).trim() !== revision)
    throw new Error('snapshot worktree does not match pinned revision')
  if (run({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'] }).trim() !== '')
    throw new Error('snapshot has tracked or query-visible untracked modifications')
  const configuration = JSON.parse(run({ command: buck2, args: ['audit', 'config', ...buckArgs, '--all-cells', '--json'] }))
  const query = ({ kind, expression, attributes = false }) => {
    const value = JSON.parse(run({ command: buck2, args: [kind, ...buckArgs, ...queryArgs, '--output-format', 'json',
      ...(attributes === true ? ['--output-all-attributes'] : []), expression] }))
    if (attributes === true && (value === null || Array.isArray(value) === true || typeof value !== 'object'))
      throw new Error('configured attributes must be a label-keyed object')
    if (attributes === false && (Array.isArray(value) === false || value.some((target) => typeof target !== 'string') === true))
      throw new Error('configured query must return a target-label array')
    return value
  }
  // Inventory failure is an error, not an empty full-set fallback.
  const required = query({ kind: 'cquery', expression: requiredQuery, attributes: true })
  const checks = Object.fromEntries(Object.keys(required).map((target) => [target, 'unknown']))
  const snapshot = { revision, configuration: digest([run({ command: buck2, args: ['--version'] }).trim(),
    buckArgs, queryArgs, configuration, requiredQuery, universeQuery, watchPlan]),
    complete: false, checks, affectedTargets: [], ownedPaths: [] }
  try {
    for (const target of Object.keys(checks)) {
      const label = target.split(' (')[0]
      const graph = query({ kind: 'cquery', expression: `deps(${JSON.stringify(label)})`, attributes: true })
      if (Object.hasOwn(graph, target) === false) throw new Error('configured root absent from its dependency graph')
      checks[target] = digest(graph)
    }
    const candidates = new Set()
    for (const path of changedPaths) {
      requireRepositoryRelativePath(path)
      for (let parent = path; parent !== '.'; parent = dirname(parent))
        if (existsSync(join(root, parent)) === true) candidates.add(parent)
    }
    const paths = [...candidates].toSorted()
    const owners = new Set()
    if (paths.length > 0) {
      mkdirSync(scratch, { recursive: true })
      const argumentFile = join(scratch, `owners-${revision}.args`)
      writeFileSync(argumentFile, paths.join('\n') + '\n', { mode: 0o600 })
      const output = run({ command: buck2, args: ['uquery', ...buckArgs, '--output-format', 'json', 'owner(%s)', `@${argumentFile}`] })
      const ownership = parseBuckOwnershipQuery({ candidates: paths, stdout: Buffer.from(output) })
      for (const path of changedPaths) {
        let covered = false
        for (let parent = path; parent !== '.'; parent = dirname(parent))
          for (const owner of ownership.get(parent) ?? []) { owners.add(owner); covered = true }
        if (covered === true) snapshot.ownedPaths.push(path)
      }
    }
    // Package products extend owner seeds with the existing reverse workspace closure.
    const packages = affectedPackagePaths({ plan: watchPlan, changedPaths })
    for (const target of buildTargetsFor({ plan: watchPlan, packagePaths: packages })) owners.add(target)
    for (const path of changedPaths)
      if (affectedPackagePaths({ plan: watchPlan, changedPaths: [path] }).length > 0)
        snapshot.ownedPaths.push(path)
    if (owners.size > 0) {
      const seeds = [...owners].map((owner) => JSON.stringify(owner)).join(' ')
      const closure = query({ kind: 'cquery', expression: `rdeps(${universeQuery}, set(${seeds}))` })
      snapshot.affectedTargets = closure.filter((target) => Object.hasOwn(checks, target))
    }
    snapshot.complete = true
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error)
  }
  if (run({ command: 'git', args: ['rev-parse', 'HEAD'] }).trim() !== revision ||
      run({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'] }).trim() !== '')
    throw new Error('snapshot changed during configured queries')
  if (canonical(configuration) !==
      canonical(JSON.parse(run({ command: buck2, args: ['audit', 'config', ...buckArgs, '--all-cells', '--json'] }))))
    throw new Error('effective Buck configuration changed during configured queries')
  return snapshot
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: configured-check-selection.mjs MANIFEST.json')
    const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    for (const snapshot of [manifest.base, manifest.candidate])
      if (/^[0-9a-f]{40}$/.test(snapshot.revision) === false) throw new Error('pins must be full commit IDs')
    const delta = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames',
      '--no-ext-diff', manifest.base.revision, manifest.candidate.revision, '--'],
      { cwd: manifest.candidate.root, encoding: 'utf8', timeout: 120000 })
    if (delta.error !== undefined || delta.status !== 0) throw new Error('cannot compute pinned changed-path delta')
    const paths = delta.stdout.split('\0').filter(Boolean).map(requireRepositoryRelativePath)
    let base
    try {
      base = collectConfiguredSnapshot({ ...manifest.base, changedPaths: paths,
        scratch: resolve(manifest.scratch, 'base') })
    } catch (error) {
      base = { revision: manifest.base.revision, configuration: '', complete: false,
        checks: {}, affectedTargets: [], ownedPaths: [],
        error: error instanceof Error ? error.message : String(error) }
    }
    const candidate = collectConfiguredSnapshot({ ...manifest.candidate, changedPaths: paths,
      scratch: resolve(manifest.scratch, 'candidate') })
    const selection = selectConfiguredChecks({ base, candidate, changedPaths: paths })
    process.stdout.write(JSON.stringify({ ...selection, changedPaths: paths,
      baseGraph: base, candidateGraph: candidate,
      selectionId: `sha256:${digest({ selection, changedPaths: paths })}` }, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
