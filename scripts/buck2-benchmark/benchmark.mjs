#!/usr/bin/env node
/* oxlint-disable overeng/named-args, overeng/explicit-boolean-compare -- Internal CLI helpers mirror subprocess APIs and parsed boolean flags. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { countNonEmptyLines, parseMaterializations, summarizeSamples } from './lib.mjs'

const schema = 'effect-utils-buck2-benchmark/v0'
const defaultRelevantPath = 'packages/@overeng/tui-core/src/mod.ts'
const defaultIrrelevantPath = 'context/dependency-materialization/intuition.md'

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const parsePositiveInteger = (flag, value) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${flag} must be a non-negative integer`)
  return parsed
}

const parseArgs = (argv) => {
  const options = {
    execute: false,
    inPlace: false,
    keepWorktree: false,
    runs: 7,
    warmups: 2,
    target: null,
    workContract: null,
    declareEquivalentWork: false,
    buckIncrementalOnly: false,
    isolationDir: 'effect-utils-benchmark',
    relevantPath: defaultRelevantPath,
    irrelevantPath: defaultIrrelevantPath,
    output: null,
    buckBin: process.env.BUCK2_BENCH_BUCK_BIN ?? null,
    hostLabel: process.env.BUCK2_BENCH_HOST_LABEL ?? 'redacted-local',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const take = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--execute') options.execute = true
    else if (arg === '--in-place') options.inPlace = true
    else if (arg === '--keep-worktree') options.keepWorktree = true
    else if (arg === '--runs') options.runs = parsePositiveInteger(arg, take())
    else if (arg === '--warmups') options.warmups = parsePositiveInteger(arg, take())
    else if (arg === '--buck-target') options.target = take()
    else if (arg === '--work-contract') options.workContract = take()
    else if (arg === '--declare-equivalent-work') options.declareEquivalentWork = true
    else if (arg === '--buck-incremental-only') options.buckIncrementalOnly = true
    else if (arg === '--isolation-dir') options.isolationDir = take()
    else if (arg === '--relevant-path') options.relevantPath = take()
    else if (arg === '--irrelevant-path') options.irrelevantPath = take()
    else if (arg === '--output') options.output = take()
    else if (arg === '--buck-bin') options.buckBin = take()
    else if (arg === '--host-label') options.hostLabel = take()
    else if (arg === '--help') {
      console.log(`usage: node benchmark.mjs [options]

Defaults to a non-executing dry run. Use --execute to run commands.

  --execute                 run the benchmark
  --in-place                use the current worktree (detached scratch is the default)
  --keep-worktree           retain a generated scratch worktree
  --runs N                  measured samples per repeatable phase (default: 7)
  --warmups N               warmup samples (default: 2)
  --buck-target LABEL       explicit Buck target under measurement
  --work-contract ID        stable ID for the reviewed workload relationship
  --declare-equivalent-work assert the contract covers equivalent work (off by default)
  --buck-incremental-only   skip Devenv and destructive cold/restart Buck phases
  --buck-bin PATH           pinned Buck2 executable
  --isolation-dir NAME      Buck daemon/cache namespace
  --relevant-path PATH      source mutation path
  --irrelevant-path PATH    non-input mutation path
  --output PATH             raw JSONL output
  --host-label LABEL        non-sensitive operator-supplied host label`)
      process.exit(0)
    } else fail(`unknown argument: ${arg}`)
  }
  if (options.runs === 0) fail('--runs must be at least 1')
  if (options.execute === true && options.target === null)
    fail('--execute requires --buck-target; there is no comparable default')
  if (options.execute === true && options.workContract === null)
    fail('--execute requires --work-contract; the workload relationship must be named')
  return options
}

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeout ?? 45 * 60 * 1000,
    stdio: options.stdio ?? 'pipe',
  })

const commandAvailable = (command, cwd) => {
  if (command.includes('/'))
    return existsSync(isAbsolute(command) ? command : resolve(cwd, command))
  return run('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], { cwd }).status === 0
}

const git = (root, args) => {
  const result = run('git', args, { cwd: root })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

const hashText = (text) => createHash('sha256').update(text).digest('hex')

const firstLine = (value) => value.split(/\r?\n/u).find((line) => line.trim() !== '') ?? ''

const toolVersion = (command, args, cwd) => {
  if (!commandAvailable(command, cwd)) return { available: false, version: null }
  const result = run(command, args, { cwd, timeout: 30_000 })
  return {
    available: result.status === 0,
    version: firstLine(`${result.stdout}\n${result.stderr}`).trim() || null,
  }
}

const directoryState = (root, path) => {
  const absolute = join(root, path)
  if (!existsSync(absolute)) return { path, exists: false, bytes: 0, files: 0 }
  const du = run('du', ['-sb', absolute], { cwd: root, timeout: 5 * 60 * 1000 })
  const find = run('find', [absolute, '-xdev', '-type', 'f', '-printf', '.'], {
    cwd: root,
    timeout: 5 * 60 * 1000,
  })
  return {
    path,
    exists: true,
    measurementStatus: du.status === 0 && find.status === 0 ? 'ok' : 'no-verdict',
    bytes: du.status === 0 ? Number(firstLine(du.stdout).split(/\s+/u)[0]) : null,
    files: find.status === 0 ? find.stdout.length : null,
  }
}

const cacheState = (root, isolationDir) => ({
  buck: directoryState(root, `buck-out/${isolationDir}`),
  devenv: directoryState(root, '.devenv'),
  pnpmStore: directoryState(root, '.devenv/pnpm-store-pure-v1'),
  nodeModules: directoryState(root, 'node_modules'),
})

const filesystemType = (root) => {
  const result = run('stat', ['-f', '-c', '%T', root], { cwd: root })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

const cpuModel = () => {
  try {
    const match = readFileSync('/proc/cpuinfo', 'utf8').match(/^model name\s*:\s*(.+)$/mu)
    return match?.[1] ?? cpus()[0]?.model ?? 'unknown'
  } catch {
    return cpus()[0]?.model ?? 'unknown'
  }
}

const safeRelative = (base, path) => {
  const value = relative(base, path)
  return value.startsWith('..') ? basename(path) : value
}

class JsonlWriter {
  constructor(path) {
    this.path = path
    this.records = []
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }

  write(record) {
    const complete = { schema, recordedAt: new Date().toISOString(), ...record }
    this.records.push(complete)
    appendFileSync(this.path, `${JSON.stringify(complete)}\n`)
  }
}

const plan = [
  ['devenv', 'end-user', 'profile-cold-store-warm'],
  ['devenv', 'end-user', 'warm-noop'],
  ['devenv', 'compute-only', 'compiler-cold'],
  ['devenv', 'compute-only', 'warm-noop'],
  ['devenv', 'compute-only', 'mtime-only', 'mtime'],
  ['devenv', 'compute-only', 'relevant-edit', 'relevant'],
  ['devenv', 'compute-only', 'irrelevant-edit', 'irrelevant'],
  ['buck2', 'workspace-check', 'action-cold'],
  ['buck2', 'workspace-check', 'warm-noop'],
  ['buck2', 'workspace-check', 'daemon-restart-cache-warm'],
  ['buck2', 'workspace-check', 'mtime-only', 'mtime'],
  ['buck2', 'workspace-check', 'relevant-edit', 'relevant'],
  ['buck2', 'workspace-check', 'irrelevant-edit', 'irrelevant'],
]

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const invocationRoot = realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']))
  const sha = git(invocationRoot, ['rev-parse', 'HEAD'])
  const runId = randomUUID()
  const defaultOutput = join(
    invocationRoot,
    'tmp',
    'buck2-benchmark',
    `${sha.slice(0, 12)}-${runId}.jsonl`,
  )
  const output = resolve(invocationRoot, options.output ?? defaultOutput)
  const artifactRoot = `${output}.artifacts`
  const summaryOutput = output.replace(/\.jsonl$/u, '') + '.summary.jsonl'
  const writer = new JsonlWriter(output)
  let scratchRoot = null
  let worktree = invocationRoot
  let worktreeAdded = false
  let cleanupComplete = false
  let buckBin = options.buckBin
  let sequence = 0

  const baseRecord = {
    runId,
    sha,
    workContract: options.workContract,
    equivalenceDeclaration:
      options.declareEquivalentWork === true
        ? 'operator-declared-not-independently-verified'
        : options.workContract === null || options.target === null
          ? 'undeclared'
          : 'work-contract-declares-no-equivalent-devenv-lane',
  }
  const env = { ...process.env, CI: '1', DEVENV_TUI: 'false' }

  const emitSkip = ({
    engine,
    surface,
    phase,
    mutation = null,
    reason,
    sampleIndex = 0,
    control = null,
  }) =>
    writer.write({
      ...baseRecord,
      kind: 'sample',
      engine,
      surface,
      phase,
      mutation,
      sampleIndex,
      warmup: false,
      status: 'skipped',
      verdict: 'no-verdict',
      reason,
      durationMs: null,
      exitCode: null,
      actionCount: null,
      materializationCount: null,
      control,
    })

  const cleanup = () => {
    if (cleanupComplete) return
    cleanupComplete = true
    let status = 'ok'
    let reason = null
    if (buckBin !== null && commandAvailable(buckBin, worktree)) {
      run(buckBin, ['--isolation-dir', options.isolationDir, 'kill'], { cwd: worktree, env })
    }
    if (worktreeAdded && !options.keepWorktree) {
      const removed = run('git', ['worktree', 'remove', '--force', worktree], {
        cwd: invocationRoot,
      })
      if (removed.status !== 0) {
        status = 'failed'
        reason = 'git-worktree-remove-failed'
      } else if (scratchRoot !== null) {
        rmSync(scratchRoot, { recursive: true, force: true })
      }
    }
    writer.write({
      ...baseRecord,
      kind: 'cleanup',
      status,
      verdict: status === 'ok' ? 'complete' : 'no-verdict',
      reason,
      scratchWorktreeRemoved: worktreeAdded && !options.keepWorktree && status === 'ok',
      scratchWorktreeRetained: worktreeAdded && options.keepWorktree,
      benchmarkCachesRetained: options.inPlace || options.keepWorktree,
    })
    const summaries = summarizeSamples(writer.records)
    writeFileSync(
      summaryOutput,
      summaries.map((record) => JSON.stringify(record)).join('\n') + '\n',
    )
  }

  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  writer.write({
    ...baseRecord,
    kind: 'metadata',
    mode: options.execute ? 'execute' : 'dry-run',
    repository: 'overengineeringstudio/effect-utils',
    dirtyAtInvocation: git(invocationRoot, ['status', '--porcelain']).length > 0,
    filesystemPageCache: 'uncontrolled-warm-or-unknown',
    destructivePageCacheOperations: false,
    remoteCache: 'disabled',
    samplePolicy: { runs: options.runs, warmups: options.warmups, percentile: 'nearest-rank' },
    host: {
      label: options.hostLabel,
      platform: platform(),
      architecture: process.arch,
      kernelRelease: release(),
      cpuModel: cpuModel(),
      logicalCpuCount: cpus().length,
      memoryBytes: { total: totalmem(), freeAtStart: freemem() },
      filesystem: filesystemType(invocationRoot),
    },
    tools: {
      node: { available: true, version: process.version },
      devenv: toolVersion('devenv', ['version'], invocationRoot),
      git: toolVersion('git', ['--version'], invocationRoot),
      nix: toolVersion('nix', ['--version'], invocationRoot),
      buck2Requested: options.buckBin,
    },
    target: options.target,
    comparison: {
      summaryGenerated: false,
      verdict: 'no-verdict',
      reason:
        options.workContract === null || options.target === null
          ? 'equivalence-contract-undeclared'
          : options.declareEquivalentWork === true
            ? 'per-engine-measurements-only'
            : 'workloads-not-declared-equivalent',
    },
    mutationPaths: {
      relevant: options.relevantPath,
      irrelevant: options.irrelevantPath,
    },
  })

  if (!options.execute) {
    for (const [engine, surface, phase, mutation] of plan) {
      emitSkip({ engine, surface, phase, mutation, reason: 'dry-run' })
    }
    writer.write({
      ...baseRecord,
      kind: 'cache-state',
      phase: 'dry-run',
      state: cacheState(invocationRoot, options.isolationDir),
    })
    cleanup()
    console.log(`dry-run plan: ${output}`)
    console.log(`dry-run summary: ${summaryOutput}`)
    return
  }

  try {
    if (!options.inPlace) {
      scratchRoot = mkdtempSync(join(tmpdir(), 'effect-utils-buck2-benchmark-'))
      worktree = join(scratchRoot, 'repo')
      const add = run('git', ['worktree', 'add', '--detach', worktree, sha], {
        cwd: invocationRoot,
      })
      if (add.status !== 0) fail('failed to create detached benchmark worktree')
      worktreeAdded = true
    } else if (git(invocationRoot, ['status', '--porcelain']).length > 0) {
      fail('--in-place requires a clean worktree')
    }

    mkdirSync(artifactRoot, { recursive: true })
    writer.write({
      ...baseRecord,
      kind: 'workspace',
      status: 'ok',
      isolation: options.inPlace ? 'clean-in-place' : 'detached-scratch-worktree',
      pathRecorded: false,
    })
    writer.write({
      ...baseRecord,
      kind: 'cache-state',
      phase: 'initial',
      state: cacheState(worktree, options.isolationDir),
    })

    const measure = ({
      engine,
      surface,
      phase,
      mutation = null,
      sampleIndex,
      warmup,
      command,
      args,
    }) => {
      const started = performance.now()
      const result = run(command, args, { cwd: worktree, env })
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000
      const stem = `${String(sequence).padStart(4, '0')}-${engine}-${phase}-${sampleIndex}`
      sequence += 1
      writeFileSync(join(artifactRoot, `${stem}.stdout.log`), result.stdout ?? '')
      writeFileSync(join(artifactRoot, `${stem}.stderr.log`), result.stderr ?? '')

      let actionCount = null
      let materializationCount = null
      let materializationBytes = null
      let materializationFiles = null
      let buckLogStatus = 'not-applicable'
      if (engine === 'buck2' && result.status === 0) {
        const common = ['--isolation-dir', options.isolationDir, 'log']
        const whatRan = run(command, [...common, 'what-ran'], { cwd: worktree, env })
        const materialized = run(command, [...common, 'what-materialized', '--format', 'json'], {
          cwd: worktree,
          env,
        })
        writeFileSync(join(artifactRoot, `${stem}.what-ran.tsv`), whatRan.stdout ?? '')
        writeFileSync(join(artifactRoot, `${stem}.materialized.jsonl`), materialized.stdout ?? '')
        if (whatRan.status === 0 && materialized.status === 0) {
          const parsed = parseMaterializations(materialized.stdout)
          actionCount = countNonEmptyLines(whatRan.stdout)
          materializationCount = parsed.count
          materializationBytes = parsed.bytes
          materializationFiles = parsed.files
          buckLogStatus = parsed.malformed === 0 ? 'ok' : 'partial'
        } else {
          buckLogStatus = 'unavailable'
        }
      }

      writer.write({
        ...baseRecord,
        kind: 'sample',
        engine,
        surface,
        phase,
        mutation,
        sampleIndex,
        warmup,
        status: result.status === 0 ? 'ok' : 'failed',
        verdict: result.status === 0 ? 'measured' : 'no-verdict',
        reason: result.status === 0 ? null : `command-exit-${result.status ?? 'signal'}`,
        durationMs,
        exitCode: result.status,
        signal: result.signal,
        command: [
          basename(command),
          ...args.map((arg) =>
            typeof arg === 'string' && arg.startsWith(artifactRoot)
              ? `<artifact-root>/${basename(arg)}`
              : arg,
          ),
        ],
        actionCount,
        materializationCount,
        materializationBytes,
        materializationFiles,
        buckLogStatus,
        evidenceVerdicts: {
          timing: result.status === 0 ? 'measured' : 'no-verdict',
          actions:
            engine !== 'buck2'
              ? 'not-applicable'
              : buckLogStatus === 'ok'
                ? 'measured'
                : 'no-verdict',
          materializations:
            engine !== 'buck2'
              ? 'not-applicable'
              : buckLogStatus === 'ok'
                ? 'measured'
                : 'no-verdict',
        },
        output: {
          stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
          stderrBytes: Buffer.byteLength(result.stderr ?? ''),
          stdoutSha256: hashText(result.stdout ?? ''),
          stderrSha256: hashText(result.stderr ?? ''),
          artifacts: safeRelative(dirname(output), join(artifactRoot, stem)),
        },
        cacheTreatment:
          engine !== 'buck2'
            ? phase === 'profile-cold-store-warm'
              ? 'new-worktree-profile-cold-nix-store-uncontrolled'
              : phase === 'compiler-cold'
                ? 'compiler-outputs-cleaned-prerequisites-retained'
                : 'retained'
            : phase === 'action-cold'
              ? 'isolation-cleaned-before-sample'
              : phase === 'daemon-restart-cache-warm'
                ? 'daemon-killed-action-cache-retained'
                : 'isolation-and-daemon-retained',
      })
      return result.status === 0
    }

    const repeat = (definition, count, warmup) => {
      let allPassed = true
      for (let index = 0; index < count; index += 1) {
        allPassed = measure({ ...definition, sampleIndex: index, warmup }) && allPassed
      }
      return allPassed
    }

    const repeatAfterWarmups = (warmupDefinition, measuredDefinition = warmupDefinition) => {
      const warmupsPassed = repeat(warmupDefinition, options.warmups, true)
      if (warmupsPassed) return repeat(measuredDefinition, options.runs, false)
      for (let index = 0; index < options.runs; index += 1) {
        emitSkip({ ...measuredDefinition, sampleIndex: index, reason: 'warmup-failed' })
      }
      return false
    }

    const endUser = ['tasks', 'run', 'ts:check', '--show-output', '--no-tui']
    const computeOnly = [
      'tasks',
      'run',
      'ts:check',
      '--mode',
      'single',
      '--show-output',
      '--no-tui',
    ]
    const cleanCompiler = () =>
      run('devenv', ['tasks', 'run', 'ts:clean', '--mode', 'single', '--show-output', '--no-tui'], {
        cwd: worktree,
        env,
      })

    if (options.buckIncrementalOnly === true) {
      for (const [engine, surface, phase, mutation] of plan.filter(
        ([engine]) => engine === 'devenv',
      )) {
        emitSkip({ engine, surface, phase, mutation, reason: 'buck-incremental-only' })
      }
    } else if (!commandAvailable('devenv', worktree)) {
      for (const [engine, surface, phase, mutation] of plan.filter(
        ([engine]) => engine === 'devenv',
      )) {
        emitSkip({ engine, surface, phase, mutation, reason: 'devenv-unavailable' })
      }
    } else {
      const prepared = measure({
        engine: 'devenv',
        surface: 'end-user',
        phase: 'profile-cold-store-warm',
        sampleIndex: 0,
        warmup: false,
        command: 'devenv',
        args: endUser,
      })
      if (prepared) {
        repeatAfterWarmups({
          engine: 'devenv',
          surface: 'end-user',
          phase: 'warm-noop',
          command: 'devenv',
          args: endUser,
        })
        for (let index = 0; index < options.runs; index += 1) {
          const cleaned = cleanCompiler()
          if (cleaned.status !== 0) {
            emitSkip({
              engine: 'devenv',
              surface: 'compute-only',
              phase: 'compiler-cold',
              reason: 'ts-clean-failed',
            })
            break
          }
          measure({
            engine: 'devenv',
            surface: 'compute-only',
            phase: 'compiler-cold',
            sampleIndex: index,
            warmup: false,
            command: 'devenv',
            args: computeOnly,
          })
        }
        repeatAfterWarmups({
          engine: 'devenv',
          surface: 'compute-only',
          phase: 'warm-noop',
          command: 'devenv',
          args: computeOnly,
        })
      } else {
        for (const [, surface, phase, mutation] of plan.filter(
          ([engine, , phase]) => engine === 'devenv' && phase !== 'profile-cold-store-warm',
        )) {
          emitSkip({
            engine: 'devenv',
            surface,
            phase,
            mutation,
            reason: 'end-user-preparation-failed',
          })
        }
      }
    }

    const profileBin = (name) => join(worktree, '.devenv', 'profile', 'bin', name)
    writer.write({
      ...baseRecord,
      kind: 'tool-resolution',
      tool: 'runtime-toolchain',
      pathRecorded: false,
      tools: {
        tsgo: toolVersion(profileBin('tsgo'), ['--version'], worktree),
        pnpm: toolVersion(profileBin('pnpm'), ['--version'], worktree),
        bun: toolVersion(profileBin('bun'), ['--version'], worktree),
        node: toolVersion(profileBin('node'), ['--version'], worktree),
      },
    })

    if (buckBin === null) {
      const profileBuck = join(worktree, '.devenv', 'profile', 'bin', 'buck2')
      buckBin = existsSync(profileBuck)
        ? profileBuck
        : commandAvailable('buck2', worktree)
          ? 'buck2'
          : null
    }
    writer.write({
      ...baseRecord,
      kind: 'tool-resolution',
      tool: 'buck2',
      available: buckBin !== null,
      version: buckBin === null ? null : toolVersion(buckBin, ['--version'], worktree).version,
      pathRecorded: false,
    })

    const makeBuckArgs = (reportStem) => [
      '--isolation-dir',
      options.isolationDir,
      'build',
      options.target,
      '--local-only',
      '--no-remote-cache',
      '--build-report',
      join(artifactRoot, `${reportStem}.build-report.json`),
      '--build-report-options',
      'include-artifact-hash-information',
    ]

    const mutationSeries = ({ engine, surface, phase, mutation, path, mutate, command, args }) => {
      const absolute = join(worktree, path)
      if (!existsSync(absolute)) {
        emitSkip({
          engine,
          surface,
          phase,
          mutation,
          reason: `mutation-path-missing:${path}`,
        })
        return
      }
      const original = readFileSync(absolute)
      const originalStat = statSync(absolute)
      try {
        for (let index = 0; index < options.runs; index += 1) {
          writeFileSync(absolute, original)
          chmodSync(absolute, originalStat.mode)
          const baselineArgs = typeof args === 'function' ? args(`base-${phase}-${index}`) : args
          const baseline = run(command, baselineArgs, {
            cwd: worktree,
            env,
          })
          if (baseline.status !== 0) {
            emitSkip({
              engine,
              surface,
              phase,
              mutation,
              sampleIndex: index,
              reason: 'mutation-baseline-failed',
              control: {
                command: [basename(command), ...baselineArgs],
                exitCode: baseline.status,
                signal: baseline.signal,
                verdict: 'no-verdict',
              },
            })
            continue
          }
          mutate(absolute, index, originalStat)
          measure({
            engine,
            surface,
            phase,
            mutation,
            sampleIndex: index,
            warmup: false,
            command,
            args: typeof args === 'function' ? args(`${phase}-${index}`) : args,
          })
        }
      } finally {
        writeFileSync(absolute, original)
        chmodSync(absolute, originalStat.mode)
        utimesSync(absolute, originalStat.atime, originalStat.mtime)
      }
    }

    if (
      options.buckIncrementalOnly === false &&
      commandAvailable('devenv', worktree) &&
      existsSync(join(worktree, 'node_modules'))
    ) {
      mutationSeries({
        engine: 'devenv',
        surface: 'compute-only',
        phase: 'mtime-only',
        mutation: 'mtime',
        path: options.relevantPath,
        mutate: (path, index, originalStat) =>
          utimesSync(path, originalStat.atime, new Date(originalStat.mtimeMs + index + 1000)),
        command: 'devenv',
        args: computeOnly,
      })
      mutationSeries({
        engine: 'devenv',
        surface: 'compute-only',
        phase: 'relevant-edit',
        mutation: 'relevant',
        path: options.relevantPath,
        mutate: (path, index) =>
          appendFileSync(path, `\nexport type Buck2BenchmarkProbe${index} = '${runId}'\n`),
        command: 'devenv',
        args: computeOnly,
      })
      mutationSeries({
        engine: 'devenv',
        surface: 'compute-only',
        phase: 'irrelevant-edit',
        mutation: 'irrelevant',
        path: options.irrelevantPath,
        mutate: (path, index) =>
          appendFileSync(path, `\n<!-- buck2-benchmark-irrelevant-${runId}-${index} -->\n`),
        command: 'devenv',
        args: computeOnly,
      })
    }

    if (buckBin === null) {
      for (const [, surface, phase, mutation] of plan.filter(([engine]) => engine === 'buck2')) {
        emitSkip({ engine: 'buck2', surface, phase, mutation, reason: 'buck2-unavailable' })
      }
    } else {
      if (options.buckIncrementalOnly === true) {
        emitSkip({
          engine: 'buck2',
          surface: 'workspace-check',
          phase: 'action-cold',
          reason: 'buck-incremental-only',
        })
        const prepared = run(buckBin, makeBuckArgs('incremental-baseline'), {
          cwd: worktree,
          env,
        })
        if (prepared.status !== 0) throw new Error('Buck incremental baseline preparation failed')
      } else
        for (let index = 0; index < options.runs; index += 1) {
          const cleanControl = run(buckBin, ['--isolation-dir', options.isolationDir, 'clean'], {
            cwd: worktree,
            env,
          })
          if (cleanControl.status !== 0) {
            emitSkip({
              engine: 'buck2',
              surface: 'workspace-check',
              phase: 'action-cold',
              reason: 'buck2-clean-control-failed',
              sampleIndex: index,
              control: {
                command: ['buck2', '--isolation-dir', options.isolationDir, 'clean'],
                exitCode: cleanControl.status,
                signal: cleanControl.signal,
                verdict: 'no-verdict',
              },
            })
            continue
          }
          measure({
            engine: 'buck2',
            surface: 'workspace-check',
            phase: 'action-cold',
            sampleIndex: index,
            warmup: false,
            command: buckBin,
            args: makeBuckArgs(`action-cold-${index}`),
          })
        }
      repeatAfterWarmups(
        {
          engine: 'buck2',
          surface: 'workspace-check',
          phase: 'warm-noop',
          command: buckBin,
          args: makeBuckArgs('warmup'),
        },
        {
          engine: 'buck2',
          surface: 'workspace-check',
          phase: 'warm-noop',
          command: buckBin,
          args: makeBuckArgs('warm-noop'),
        },
      )
      if (options.buckIncrementalOnly === true) {
        emitSkip({
          engine: 'buck2',
          surface: 'workspace-check',
          phase: 'daemon-restart-cache-warm',
          reason: 'buck-incremental-only',
        })
      } else
        for (let index = 0; index < options.runs; index += 1) {
          const killControl = run(buckBin, ['--isolation-dir', options.isolationDir, 'kill'], {
            cwd: worktree,
            env,
          })
          if (killControl.status !== 0) {
            emitSkip({
              engine: 'buck2',
              surface: 'workspace-check',
              phase: 'daemon-restart-cache-warm',
              reason: 'buck2-kill-control-failed',
              sampleIndex: index,
              control: {
                command: ['buck2', '--isolation-dir', options.isolationDir, 'kill'],
                exitCode: killControl.status,
                signal: killControl.signal,
                verdict: 'no-verdict',
              },
            })
            continue
          }
          measure({
            engine: 'buck2',
            surface: 'workspace-check',
            phase: 'daemon-restart-cache-warm',
            sampleIndex: index,
            warmup: false,
            command: buckBin,
            args: makeBuckArgs(`daemon-restart-${index}`),
          })
        }
      mutationSeries({
        engine: 'buck2',
        surface: 'workspace-check',
        phase: 'mtime-only',
        mutation: 'mtime',
        path: options.relevantPath,
        mutate: (path, index, originalStat) =>
          utimesSync(path, originalStat.atime, new Date(originalStat.mtimeMs + index + 1000)),
        command: buckBin,
        args: (stem) => makeBuckArgs(stem),
      })
      mutationSeries({
        engine: 'buck2',
        surface: 'workspace-check',
        phase: 'relevant-edit',
        mutation: 'relevant',
        path: options.relevantPath,
        mutate: (path, index) =>
          appendFileSync(path, `\nexport type Buck2BenchmarkProbe${index} = '${runId}'\n`),
        command: buckBin,
        args: (stem) => makeBuckArgs(stem),
      })
      mutationSeries({
        engine: 'buck2',
        surface: 'workspace-check',
        phase: 'irrelevant-edit',
        mutation: 'irrelevant',
        path: options.irrelevantPath,
        mutate: (path, index) =>
          appendFileSync(path, `\n<!-- buck2-benchmark-irrelevant-${runId}-${index} -->\n`),
        command: buckBin,
        args: (stem) => makeBuckArgs(stem),
      })
    }

    writer.write({
      ...baseRecord,
      kind: 'cache-state',
      phase: 'final',
      state: cacheState(worktree, options.isolationDir),
    })
  } finally {
    cleanup()
  }

  console.log(`raw benchmark: ${output}`)
  console.log(`summary: ${summaryOutput}`)
}

main()
