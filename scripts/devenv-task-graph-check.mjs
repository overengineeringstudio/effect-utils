#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

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
const missingDependencies = []
for (const [name, task] of tasks) {
  for (const dependency of task.after ?? []) {
    const upstream = dependencyName(dependency)
    if (upstream === undefined) continue
    ensureTask(upstream)
    if (tasks.has(upstream) === false) missingDependencies.push(`${name}.after -> ${upstream}`)
    dependencies.get(name).add(upstream)
  }
  for (const dependency of task.before ?? []) {
    const downstream = dependencyName(dependency)
    if (downstream === undefined) continue
    if (tasks.has(downstream) === false) missingDependencies.push(`${name}.before -> ${downstream}`)
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
ok({
  condition: missingDependencies.length === 0,
  name: 'every task dependency resolves to an evaluated task',
  detail: missingDependencies.join(', '),
})
if (process.env.DEVENV_TASK_GRAPH_DEPENDENCIES_ONLY === '1') process.exit(0)
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
  'check:quick',
  'check:all',
  'nix:check:quick',
  'nix:buck2-artifact-import:check',
  'nix:javascript-product-import:check',
  'setup:strict',
  'genie:run',
  'genie:check',
  'mr:apply',
  'buck2:providers:check',
  'buck2:quick',
  'buck2:all',
  'check:buck2-producer-overlap',
  'buck2:typescript:materialize-dist',
  'buck2:editor:bootstrap',
  'buck2:editor:materialize',
  'buck2:editor:authority',
  'buck2:editor:publish',
  'buck2:editor:check',
  'buck2:editor:publish:restate-effect',
  'buck2:editor:publish:otel-contract',
  'buck2:editor:publish:playwright',
  'test:run',
  'test:buck2:unit',
])
  requireTask(name)
for (const name of [
  'ts:check',
  'ts:check:strict',
  'ts:build',
  'ts:build-watch',
  'ts:emit',
  'pnpm:install',
  'pnpm:link-native-node-packages',
]) {
  ok({
    condition: tasks.has(name) === false,
    name: `${name} is absent after its Buck authority cutover`,
  })
}
for (const name of ['mr:setup', 'mr:check', 'mr:lock-sync-check', 'mr:source-policy-check']) {
  ok({
    condition: tasks.has(name) === false,
    name: `${name} is absent after the standalone check-surface cut`,
  })
}
for (const name of ['nix:build', 'nix:check']) {
  ok({
    condition: tasks.has(name) === false,
    name: `${name} is absent without repository pnpm FOD producers`,
  })
}

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
for (const [checkTask, aggregateTask] of [
  ['check:quick', 'buck2:quick'],
  ['check:all', 'buck2:all'],
]) {
  ok({
    condition: reaches({ start: checkTask, target: aggregateTask }),
    name: `${checkTask} reaches ${aggregateTask}`,
  })
  ok({
    condition: reaches({ start: checkTask, target: 'check:buck2-producer-overlap' }),
    name: `${checkTask} reaches the Buck producer overlap guard`,
  })
}
for (const checkTask of ['check:quick', 'check:all']) {
  ok({
    condition: reaches({ start: checkTask, target: 'nix:check:quick' }),
    name: `${checkTask} reaches the Nix artifact-import aggregate`,
  })
  for (const importTask of [
    'nix:buck2-artifact-import:check',
    'nix:javascript-product-import:check',
  ]) {
    ok({
      condition: reaches({ start: checkTask, target: importTask }),
      name: `${checkTask} reaches ${importTask}`,
    })
  }
  ok({
    condition: reaches({ start: checkTask, target: 'buck2:nix-bridge:check' }) === false,
    name: `${checkTask} does not realize a repository product`,
  })
  ok({
    condition: reaches({ start: checkTask, target: 'nix:flake:check' }) === false,
    name: `${checkTask} does not run unrestricted flake checks`,
  })
}
for (const checkTask of ['check:quick', 'check:all']) {
  ok({
    condition: reaches({ start: checkTask, target: 'mr:apply' }) === false,
    name: `${checkTask} does not reach mr:apply`,
  })
}
// `test:run` must schedule the one Buck aggregate and the source-side batches which own
// packages absent from the authority plus admitted lanes' exact unbounded complements. Either
// edge going missing would silently omit a disjoint side of the test partition.
const testRunDependencies = [...(dependencies.get('test:run') ?? [])]
ok({
  condition: testRunDependencies.includes('test:buck2:unit'),
  name: 'test:run executes the Buck-owned bounded partition',
})
ok({
  condition: testRunDependencies.some((name) => name.startsWith('test:run:batch:') === true),
  name: 'test:run executes the source-owned complement partition',
})
// `genie:check` prevents a stale graph from proving itself. It is the freshness barrier for
// repository-root Buck tasks. `mr:apply` remains an explicit composition operation.
const buck2TestAuthority = JSON.parse(readFileSync(`${root}/buck2-test-authority.json`, 'utf8'))
if (buck2TestAuthority.schemaVersion !== 2 || Array.isArray(buck2TestAuthority.lanes) === false) {
  throw new Error('buck2-test-authority.json does not match schemaVersion 2')
}
for (const lane of buck2TestAuthority.lanes) {
  if (
    typeof lane.taskName !== 'string' ||
    typeof lane.sourceOwners !== 'object' ||
    lane.sourceOwners === null ||
    Array.isArray(lane.sourceOwners) === true
  ) {
    throw new Error('buck2-test-authority.json contains a malformed lane')
  }
}
const buck2TestLaneTaskNames = buck2TestAuthority.lanes.map(({ taskName }) => taskName)
const buck2UnboundedTaskNames = buck2TestAuthority.lanes.flatMap(({ unboundedTaskName }) =>
  unboundedTaskName === undefined ? [] : [unboundedTaskName],
)
const buck2ExternalOwnerTaskNames = [
  ...new Set(buck2TestAuthority.lanes.flatMap(({ sourceOwners }) => Object.values(sourceOwners))),
]
for (const name of [...buck2UnboundedTaskNames, ...buck2ExternalOwnerTaskNames]) {
  ok({
    condition: tasks.has(name),
    name: `${name} exists as a source-side test owner`,
  })
}
const standaloneBuckTaskNames = [
  'buck2:editor:authority',
  'buck2:editor:publish',
  'buck2:editor:check',
  'buck2:editor:publish:restate-effect',
  'buck2:editor:publish:otel-contract',
  'buck2:editor:publish:playwright',
  'buck2:nix-bridge:check',
  'nix:buck2-artifact-import:check',
  'nix:javascript-product-import:check',
  'lint:check',
  'lint:check:format',
  'lint:check:genie:coverage',
  'lint:check:oxlint',
  'test:buck2:unit',
  ...buck2TestLaneTaskNames,
  ...buck2ExternalOwnerTaskNames,
]
for (const name of standaloneBuckTaskNames) {
  ok({
    condition: reaches({ start: name, target: 'mr:apply' }) === false,
    name: `${name} remains standalone`,
  })
  ok({
    condition: reaches({ start: name, target: 'genie:check' }),
    name: `${name} waits for source-side generation freshness`,
  })
}
for (const name of [
  'buck2:providers:check',
  'buck2:quick',
  'buck2:all',
  'buck2:nix-bridge:check',
  'buck2:editor:bootstrap',
]) {
  ok({
    condition: reaches({ start: name, target: 'mr:apply' }) === false,
    name: `${name} remains standalone`,
  })
}
ok({
  condition:
    reaches({ start: 'buck2:editor:bootstrap', target: 'mr:setup' }) === false &&
    reaches({ start: 'buck2:editor:bootstrap', target: 'genie:check' }) === false,
  name: 'editor bootstrap reads committed standalone dependencies without mutating projections',
})

const scopedPublisherContracts = {
  'buck2:editor:publish:restate-effect': {
    consumers: ['test:restate-integration'],
    packagePaths: ['packages/@overeng/restate-effect'],
  },
  'buck2:editor:publish:otel-contract': {
    consumers: ['weaver:live-check'],
    packagePaths: ['packages/@overeng/otel-contract'],
  },
  'buck2:editor:publish:playwright': {
    consumers: ['test:pw:tui-react', 'test:pw:utils'],
    packagePaths: ['packages/@overeng/tui-react', 'packages/@overeng/utils'],
  },
}
for (const [publisher, { consumers, packagePaths }] of Object.entries(scopedPublisherContracts)) {
  const publisherDependencies = [...(dependencies.get(publisher) ?? [])]
  ok({
    condition: publisherDependencies.length === 1 && publisherDependencies[0] === 'genie:check',
    name: `${publisher} waits directly and only for standalone generator freshness`,
  })
  const publisherTask = requireTask(publisher)
  const command = publisherTask.command
  ok({
    condition: publisherTask.hasExec === true || typeof command === 'string',
    name: `${publisher} declares an executable publisher`,
  })
  if (typeof command === 'string') {
    const commandBody = existsSync(command) === true ? readFileSync(command, 'utf8') : ''
    ok({
      condition:
        command.includes(publisher.replaceAll(':', '-')) &&
        commandBody.includes('--packages') &&
        packagePaths.every((packagePath) => commandBody.includes(`"${packagePath}"`)),
      name: `${publisher} has its distinct trace identity and explicit canonical package scope`,
      detail: command,
    })
  }
  const actualConsumers = [...dependencies]
    .filter(([, taskDependencies]) => taskDependencies.has(publisher))
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b))
  ok({
    condition:
      JSON.stringify(actualConsumers) ===
      JSON.stringify(consumers.toSorted((a, b) => a.localeCompare(b))),
    name: `${publisher} is coalesced across exactly its intended consumers`,
    detail: `expected ${consumers.join(', ')}, received ${actualConsumers.join(', ')}`,
  })
}
const fullPublisherTask = requireTask('buck2:editor:publish')
const fullPublisherCommand = fullPublisherTask.command
ok({
  condition: fullPublisherTask.hasExec === true || typeof fullPublisherCommand === 'string',
  name: 'whole-workspace editor publication declares an executable fallback',
})
if (typeof fullPublisherCommand === 'string') {
  const fullPublisherCommandBody =
    existsSync(fullPublisherCommand) === true ? readFileSync(fullPublisherCommand, 'utf8') : ''
  ok({
    condition:
      fullPublisherCommand.includes('buck2-editor-publish') &&
      fullPublisherCommandBody.includes('--packages') === false,
    name: 'whole-workspace editor publication retains its unscoped fallback',
    detail: fullPublisherCommand,
  })
}
ok({
  condition:
    [...(dependencies.get('test:pw:tui-react') ?? [])].join('\n') ===
    [...(dependencies.get('test:pw:utils') ?? [])].join('\n'),
  name: 'both Playwright lanes depend on one canonical union publisher',
})

ok({
  condition:
    reaches({
      start: 'buck2:typescript:materialize-dist',
      target: 'buck2:editor:materialize',
    }) === true && reaches({ start: 'setup:strict', target: 'buck2:editor:materialize' }) === true,
  name: 'mutating setup and dist publication share the ordered editor materialization barrier',
})
ok({
  condition: reaches({ start: 'genie:check', target: 'genie:run' }) === false,
  name: 'standalone generation freshness never invokes the projection producer',
})

const source = readFileSync(`${root}/devenv.nix`, 'utf8')
const taskSource = (name) => {
  const start = source.indexOf(`  tasks."${name}" = {`)
  ok({ condition: start !== -1, name: `devenv.nix contains ${name}` })
  const end = source.indexOf('\n  tasks."', start + 1)
  return source.slice(start, end === -1 ? source.length : end)
}

const editorMaterializeSource = taskSource('buck2:editor:materialize')
const orderedMaterializationSteps = [
  'devenv tasks run buck2:editor:bootstrap --mode single',
  'devenv tasks run genie:run --mode single',
  'devenv tasks run genie:check --mode single',
  'devenv tasks run buck2:editor:publish --mode single',
]
const orderedMaterializationOffsets = orderedMaterializationSteps.map((step) =>
  editorMaterializeSource.indexOf(step),
)
ok({
  condition: orderedMaterializationOffsets.every(
    (offset, index) =>
      offset !== -1 && (index === 0 || offset > orderedMaterializationOffsets[index - 1]),
  ),
  name: 'editor materialization runs bootstrap, generation, freshness, and publication in order',
})

const materializerSource = taskSource(materializer)
const typescriptAuthorityRuntimePath = 'genie/buck2/typescript-authority-runtime.ts'
const typescriptAuthorityRuntimeSource = readFileSync(
  `${root}/${typescriptAuthorityRuntimePath}`,
  'utf8',
)
ok({
  condition:
    materializerSource.includes(typescriptAuthorityRuntimePath) === true &&
    materializerSource.includes('materialize-dist "$root"') === true &&
    materializerSource.includes('WORKSPACE_ROOT="$root"') === true,
  name: 'materializer dispatches the registry-backed TypeScript authority runtime',
})
ok({
  condition:
    typescriptAuthorityRuntimeSource.includes('authoritativeBuck2TypeScriptDeclarations') ===
      true &&
    typescriptAuthorityRuntimeSource.includes('admissions.map(') === true &&
    typescriptAuthorityRuntimeSource.includes("'materialize-one'") === true &&
    typescriptAuthorityRuntimeSource.includes('scripts/typescript-materialize-dist.sh') === false &&
    typescriptAuthorityRuntimeSource.includes('packages/@overeng/tui-core') === false &&
    typescriptAuthorityRuntimeSource.includes('packages/@overeng/tui-react') === false,
  name: 'TypeScript authority runtime derives publication from the declaration registry',
})
ok({
  condition:
    source.includes('typescriptPublicationRootPredicate =') === true &&
    source.includes('--workspace-root "$root"') === true &&
    source.includes('--buck2 "$BUCK2_BIN"') === true &&
    materializerSource.includes('requires a composed megarepo workspace') === false &&
    materializerSource.includes('WORKSPACE_ROOT="$root"') === true &&
    materializerSource.includes('BUCK2_BIN="$workspace_root/.megarepo/bin/"buck2') === true &&
    materializerSource.includes('TYPESCRIPT_DIST_MODE=') === false &&
    materializerSource.includes('TSGO_BIN=') === false,
  name: 'materializer defaults to the standalone root and preserves explicit composed publication',
})

const editorViewHelper = source.slice(
  source.indexOf('  editorViewExec ='),
  source.indexOf('\nin\n{', source.indexOf('  editorViewExec =')),
)
for (const term of ['--isolation-dir', 'buck-out']) {
  ok({
    condition: editorViewHelper.includes(term) === false,
    name: `whole-workspace editor publisher has no ${term} lifecycle`,
  })
}
ok({
  condition: /\bbuck2[^\n]*\bkill\b/.test(editorViewHelper) === false,
  name: 'whole-workspace editor publisher never kills the shared Buck daemon',
})

const buckProviderCheckSource = taskSource('buck2:providers:check')
const buckQuickSource = taskSource('buck2:quick')
const buckAllSource = taskSource('buck2:all')
const producerOverlapSource = taskSource('check:buck2-producer-overlap')
ok({
  condition:
    source.includes('buck2AggregateExec =') === true &&
    buckProviderCheckSource.includes('audit providers') === true &&
    buckProviderCheckSource.includes('typescript-authority-runtime.ts') === false &&
    buckQuickSource.includes('buck2AggregateExec "buck2:quick" "//:quick"') === true &&
    buckAllSource.includes('buck2AggregateExec "buck2:all" "//:all"') === true &&
    buckQuickSource.includes('--local-only') === false &&
    buckAllSource.includes('--local-only') === false,
  name: 'Buck check tasks separate provider audit from standalone cache-enabled aggregates',
})
ok({
  condition:
    producerOverlapSource.includes('genie/buck2/producer-overlap.ts') === true &&
    producerOverlapSource.includes('task-config-devenv-config-task-config') === true,
  name: 'producer overlap guard reads the evaluated task registry',
})
const buckToolchainSource = readFileSync(`${root}/buck2/toolchains/BUCK`, 'utf8')
ok({
  condition:
    buckToolchainSource.includes('bun_toolchain(') === true &&
    buckToolchainSource.includes('name = "archive_tool"') === true,
  name: 'Buck toolchains live in the buck2/toolchains package',
})
const configuredToolchainSource = readFileSync(`${root}/buck2/toolchains/configured.bzl`, 'utf8')
ok({
  condition:
    buckToolchainSource.includes('load("@capabilities//:defs.bzl"') === true &&
    configuredToolchainSource.includes('load("@capabilities//:defs.bzl"') === true,
  name: 'capability Starlark loads use external-cell import syntax',
})
const standaloneBuckConfig = readFileSync(`${root}/.buckconfig`, 'utf8')
const compositionRootSource = readFileSync(
  `${root}/packages/@overeng/megarepo/src/composition/root/composition-root.ts`,
  'utf8',
)
ok({
  condition:
    standaloneBuckConfig.includes('file_watcher = notify') === true &&
    standaloneBuckConfig.includes('file_watcher = watchman') === false &&
    compositionRootSource.includes("lines.push('', '[buck2]', '  file_watcher = watchman')") ===
      true,
  name: 'standalone roots use notify while composed roots retain Watchman',
})
ok({
  condition: existsSync(`${root}/toolchains`) === false,
  name: 'no legacy top-level toolchains directory remains',
})

console.log(`1..${testCount}`)
