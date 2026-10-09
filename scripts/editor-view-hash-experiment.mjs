// Temporary #1743 experiment branch only; never merge into main.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const iterations = Number(process.env.EDITOR_HASH_ITERATIONS ?? 15)
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 15)
assert.equal(process.env.EDITOR_VIEW_TEST_PUBLICATION_WORKERS, '4')
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
const save = (reason) => writeFileSync(join(output, 'result.json'), JSON.stringify({ reason, iterations, workers: 4, completed: results.length, results }, null, 2) + '\n')
for (let iteration = 1; iteration <= iterations; iteration++) {
  const removed = coldViews()
  const logPath = join(output, `publication-${iteration}.log`)
  const tracePath = join(output, `syscalls-${iteration}.log`)
  const log = createWriteStream(logPath)
  const start = Date.now()
  process.stdout.write(`Experiment iteration ${iteration}/${iterations}: four workers, ${removed.length} removed state roots\n`)
  const child = spawn('devenv', ['tasks', 'run', 'buck2:editor:publish'], { cwd: root, env: { ...process.env, EDITOR_VIEW_TEST_SYSCALL_TRACE: tracePath }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const { code, signal } = await new Promise((resolveExit, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  log.end()
  await finished(log)
  const text = readFileSync(logPath, 'utf8')
  const errors = text.split('\n').filter(line => line.includes('tree changed while hashing') || line.includes('; publication workers='))
  const hit = text.includes('tree changed while hashing')
  const result = { iteration, code, signal, durationMs: Date.now() - start, removed, hit, errors }
  results.push(result)
  process.stdout.write(JSON.stringify(result) + '\n')
  save(hit ? 'first hash instability captured' : code === 0 ? 'continuing' : 'unrelated publication failure')
  if (hit || code !== 0) {
    if (existsSync(tracePath)) {
      await pipeline(createReadStream(tracePath), createGzip({ level: 9 }), createWriteStream(`${tracePath}.gz`))
      rmSync(tracePath)
    }
    process.stdout.write(text.slice(-32000))
    process.exitCode = code === 0 ? 1 : code ?? 1
    break
  }
  // Preserve compact successful logs, not millions of irrelevant read/open syscalls.
  if (existsSync(tracePath)) rmSync(tracePath)
}
if (results.length === iterations && results.every(result => result.code === 0)) save('iteration bound reached without hash instability')
