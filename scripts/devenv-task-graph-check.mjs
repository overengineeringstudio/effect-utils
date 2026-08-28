#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = process.argv[2]
if (root === undefined) {
  console.error(`usage: ${process.argv[1]} REPO_ROOT`)
  process.exit(2)
}

const evaluatedTaskJson = process.env.DEVENV_TASKS_JSON
let taskJson
if (evaluatedTaskJson === undefined) {
  const devenv = process.env.DEVENV_BIN ?? 'devenv'
  const result = spawnSync(devenv, ['--no-reload', 'tasks', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVENV_TUI: 'false' },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    console.error(`devenv tasks list --json failed with exit ${result.status}`)
    process.exit(result.status ?? 1)
  }
  taskJson = result.stdout
} else {
  taskJson = readFileSync(evaluatedTaskJson, 'utf8')
}

let document
try {
  document = JSON.parse(taskJson)
} catch (error) {
  console.error('devenv tasks list --json did not return valid JSON')
  console.error(error)
  process.exit(1)
}

const rawTasks =
  Array.isArray(document) === true
    ? document.map((task) => [task.name, task])
    : Array.isArray(document.tasks) === true
      ? document.tasks.map((task) => [task.name, task])
      : Object.entries(document.tasks ?? document)

const tasks = new Map()
for (const [key, value] of rawTasks) {
  if (value === null || typeof value !== 'object') continue
  const name = value.name ?? key
  if (typeof name !== 'string') continue
  tasks.set(name, value)
}

const dependencyName = (dependency) => {
  const value = typeof dependency === 'string' ? dependency : dependency?.name
  if (typeof value !== 'string') return undefined
  return value.replace(/@(started|ready|succeeded|completed)$/, '')
}
const dependencies = new Map([...tasks.keys()].map((name) => [name, new Set()]))
const ensureTask = (name) => {
  if (dependencies.has(name) === false) dependencies.set(name, new Set())
}
for (const [name, task] of tasks) {
  for (const dependency of task.after ?? []) {
    const upstream = dependencyName(dependency)
    if (upstream === undefined) continue
    ensureTask(upstream)
    dependencies.get(name).add(upstream)
  }
  for (const dependency of task.before ?? []) {
    const downstream = dependencyName(dependency)
    if (downstream === undefined) continue
    ensureTask(downstream)
    dependencies.get(downstream).add(name)
  }
}

let testCount = 0
const ok = ({ condition, name, detail = '' }) => {
  if (condition === false) {
    console.error(`not ok ${testCount + 1} - ${name}${detail === '' ? '' : `: ${detail}`}`)
    process.exit(1)
  }
  testCount += 1
  console.log(`ok ${testCount} - ${name}`)
}
const requireTask = (name) => {
  const task = tasks.get(name)
  ok({ condition: task !== undefined, name: `evaluated graph contains ${name}` })
  return task
}
const reaches = ({ start, target }) => {
  const seen = new Set()
  const visit = (name) => {
    if (name === target) return true
    if (seen.has(name) === true) return false
    seen.add(name)
    return [...(dependencies.get(name) ?? [])].some(visit)
  }
  return visit(start)
}

for (const name of [
  'ts:check',
  'ts:check:strict',
  'check:quick',
  'buck2:check',
  'buck2:typescript:materialize-dist',
  'buck2:tui-core:publish-editor',
  'buck2:tui-core:check-editor',
])
  requireTask(name)

const visiting = new Set()
const visited = new Set()
const visitAcyclic = (name) => {
  if (visiting.has(name) === true) throw new Error(`cycle reaches ${name}`)
  if (visited.has(name) === true) return
  visiting.add(name)
  for (const dependency of dependencies.get(name) ?? []) visitAcyclic(dependency)
  visiting.delete(name)
  visited.add(name)
}
try {
  for (const name of dependencies.keys()) visitAcyclic(name)
  ok({ condition: true, name: 'evaluated task graph is acyclic' })
} catch (error) {
  ok({ condition: false, name: 'evaluated task graph is acyclic', detail: error.message })
}

const materializer = 'buck2:typescript:materialize-dist'
for (const name of ['ts:check', 'ts:check:strict', 'check:quick']) {
  ok({
    condition: reaches({ start: name, target: materializer }),
    name: `${name} reaches ${materializer}`,
  })
}

const source = readFileSync(`${root}/devenv.nix`, 'utf8')
const taskSource = (name) => {
  const start = source.indexOf(`  tasks."${name}" = {`)
  ok({ condition: start !== -1, name: `devenv.nix contains ${name}` })
  const end = source.indexOf('\n  tasks."', start + 1)
  return source.slice(start, end === -1 ? source.length : end)
}

const materializerSource = taskSource(materializer)
ok({
  condition:
    materializerSource.includes('typescript-materialize-dist.sh') === true &&
    materializerSource.includes('effect_utils//packages/@overeng/tui-core:dist') === true &&
    materializerSource.includes('effect_utils//packages/@overeng/tui-react:dist') === true &&
    materializerSource.includes('BUCK2_BIN=') === true,
  name: 'materializer dispatches the tested Buck publication helper',
})

for (const name of ['buck2:tui-core:publish-editor', 'buck2:tui-core:check-editor']) {
  const task = taskSource(name)
  ok({
    condition: task.includes('--isolation-dir') === false,
    name: `${name} has no dynamic isolation directory`,
  })
  ok({ condition: /buck2[^\n]*\bkill\b/.test(task) === false, name: `${name} has no daemon kill` })
  ok({ condition: task.includes('buck-out') === false, name: `${name} has no buck-out cleanup` })
}

const buckCheckSource = taskSource('buck2:check')
ok({
  condition:
    buckCheckSource.includes('realpath "$root/../.."') === true &&
    buckCheckSource.includes('$workspace_root/.megarepo/bin/buck2') === true,
  name: 'buck2:check resolves the composition root wrapper from the owned member',
})
const buckToolchainSource = readFileSync(`${root}/toolchains/BUCK`, 'utf8')
ok({
  condition:
    buckToolchainSource.includes('store_dir = "repos/effect-utils/.devenv/pnpm-store-pure-v1"') ===
    true,
  name: 'Buck pnpm materializer store is composition-root relative',
})

console.log(`1..${testCount}`)
