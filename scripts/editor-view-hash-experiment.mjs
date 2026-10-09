// Temporary #1743 experiment branch only; never merge into main.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'

const iterations = Number(process.env.EDITOR_HASH_ITERATIONS ?? 15)
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 15)
assert.equal(process.env.EDITOR_VIEW_TEST_PUBLICATION_WORKERS, '4')
assert.ok(process.env.DEVENV_BIN, 'use the CI devenv binary resolved from devenv.lock')
const root = process.cwd()
const output = resolve(process.env.RUNNER_TEMP ?? 'tmp', 'editor-view-hash-experiment')
mkdirSync(output, { recursive: true })
const skipped = new Set(['.git', 'buck-out', '.devenv', 'node_modules', 'target', 'tmp'])
const writableDirectories = (path) => {
  if (!lstatSync(path).isDirectory()) return
  chmodSync(path, 0o755)
  for (const name of readdirSync(path)) writableDirectories(join(path, name))
}
const coldViews = () => {
  const removed = []
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      if (skipped.has(name)) continue
      const path = join(directory, name)
      if (!lstatSync(path).isDirectory()) continue
      if (name === '.editor-view') {
        writableDirectories(path)
        rmSync(path, { recursive: true })
        removed.push(path)
      } else visit(path)
    }
  }
  visit(root)
  return removed
}
const results = []
let active = null
const save = (reason) => writeFileSync(join(output, 'result.json'), JSON.stringify({ reason, iterations, workers: 4, instrumentation: 'untraced publisher; nonrecursive Linux inotify store lifecycle only (no PID attribution)', active, completed: results.length, results }, null, 2) + '\n')
const observeStores = (iteration) => {
  const lifecycle = createWriteStream(join(output, `store-lifecycle-${iteration}.log`))
  const attached = new Map()
  const stores = ['.', 'context', 'packages', 'packages/@overeng/effect-rpc-tanstack'].map(path => join(root, path, '.editor-view', '.store'))
  const attach = () => {
    for (const store of stores) {
      if (attached.has(store) || !existsSync(store)) continue
      const observer = watch(store, { persistent: false }, (event, name) => {
        lifecycle.write(JSON.stringify({ timestamp: new Date().toISOString(), store, event, name: name?.toString(), pid: null }) + '\n')
      })
      observer.on('error', error => lifecycle.write(JSON.stringify({ timestamp: new Date().toISOString(), store, error: String(error) }) + '\n'))
      attached.set(store, observer)
      lifecycle.write(JSON.stringify({ timestamp: new Date().toISOString(), store, watching: true }) + '\n')
    }
  }
  attach()
  const discover = setInterval(attach, 1000)
  discover.unref()
  return async () => {
    clearInterval(discover)
    for (const observer of attached.values()) observer.close()
    lifecycle.end()
    await finished(lifecycle)
  }
}
for (let iteration = 1; iteration <= iterations; iteration++) {
  const removed = coldViews()
  const logPath = join(output, `publication-${iteration}.log`)
  const stopObserving = observeStores(iteration)
  const log = createWriteStream(logPath)
  const start = Date.now()
  const startedAt = new Date(start).toISOString()
  active = { iteration, startedAt, removed, phase: 'devenv tasks run buck2:editor:publish' }
  save('iteration started')
  process.stdout.write(`[${startedAt}] Experiment iteration ${iteration}/${iterations} START: four workers, ${removed.length} removed state roots, no syscall tracing\n`)
  const childEnv = { ...process.env, DEVENV_TASK_PASSTHROUGH: '1', DEVENV_TUI: 'false' }
  delete childEnv.EDITOR_VIEW_TEST_SYSCALL_TRACE
  const child = spawn(process.env.DEVENV_BIN, ['tasks', 'run', 'buck2:editor:publish'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  const { code, signal } = await new Promise((resolveExit, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  log.end()
  await finished(log)
  await stopObserving()
  const text = readFileSync(logPath, 'utf8')
  const errors = text.split('\n').filter(line => line.includes('tree changed while hashing') || line.includes('; publication workers='))
  const hit = text.includes('tree changed while hashing')
  const result = { iteration, startedAt, completedAt: new Date().toISOString(), code, signal, durationMs: Date.now() - start, removed, hit, errors }
  results.push(result)
  active = null
  process.stdout.write(`[${result.completedAt}] Experiment iteration ${iteration}/${iterations} END ${JSON.stringify(result)}\n`)
  save(hit ? 'first hash instability captured' : code === 0 ? 'continuing' : 'unrelated publication failure')
  if (hit || code !== 0) {
    process.stdout.write(text.slice(-32000))
    process.exitCode = code === 0 ? 1 : code ?? 1
    break
  }
}
if (results.length === iterations && results.every(result => result.code === 0)) save('iteration bound reached without hash instability')
