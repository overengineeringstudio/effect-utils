/**
 * Runner for the story gate: derives baselines from a git ref, captures both
 * sides on one host, and reports every way the story set can move.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { baselineDirEnvVar, manifestEnvVar } from './project.ts'

/** How a story's render differs from the baseline ref. */
export type StoryGateChangeKind = 'pixels' | 'dimensions' | 'accessibility' | 'other'

/** One story that did not reproduce the baseline. */
export interface StoryGateChange {
  readonly story: string
  readonly kind: StoryGateChangeKind
  readonly detail: string
}

/** Outcome of one gate run. */
export interface StoryGateReport {
  readonly baselineRef: string
  readonly baselineSha: string
  readonly baselineDir: string
  /** Baselines the current tree asked for. */
  readonly comparedStories: number
  /** Stories present now with no baseline at the ref. */
  readonly added: readonly string[]
  /** Baselines at the ref that the current tree never asked for. */
  readonly removed: readonly string[]
  /** Stories that rendered differently, including dimension mismatches. */
  readonly changed: readonly StoryGateChange[]
  readonly ok: boolean
}

/** Options for {@link runStoryGate}. */
export interface StoryGateRunOptions {
  /** Package directory holding `.storybook` and the gate's Vitest config. */
  readonly packageDir: string
  /** Git ref whose render is the baseline. */
  readonly baselineRef: string
  /** Vitest config file, relative to `packageDir`. @default 'vitest.gate.config.ts' */
  readonly configFile?: string
  /** Scratch root. @default `<repoRoot>/node_modules/.cache/overeng-story-gate` */
  readonly cacheDir?: string
  /** Re-derive the baseline even if a complete capture is already cached. */
  readonly refresh?: boolean
}

const runGit = ({ args, cwd }: { args: readonly string[]; cwd: string }): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`[story-gate] git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

const listPngs = (root: string): string[] => {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => join(entry.parentPath, entry.name))
}

/**
 * Every package that has its own `node_modules` in the working tree, so the
 * derived worktree can borrow them instead of installing again. Only sound when
 * the lockfile has not moved between the two refs, which the caller checks.
 */
const linkNodeModules = ({
  repoRoot,
  worktreeDir,
}: {
  repoRoot: string
  worktreeDir: string
}): void => {
  const packageDirs = readdirSync(worktreeDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === 'package.json')
    .map((entry) => relative(worktreeDir, entry.parentPath))

  for (const packageDir of ['', ...packageDirs]) {
    const source = join(repoRoot, packageDir, 'node_modules')
    const target = join(worktreeDir, packageDir, 'node_modules')
    if (!existsSync(source) || existsSync(target)) continue
    symlinkSync(source, target, 'dir')
  }
}

const runVitest = ({
  cwd,
  configFile,
  baselineDir,
  manifest,
  reportFile,
  update,
}: {
  cwd: string
  configFile: string
  baselineDir: string
  manifest: string | undefined
  reportFile: string
  update: boolean
}): { readonly status: number; readonly output: string } => {
  // The package's own binary, not `pnpm exec`: the runner is invoked from
  // scripts and CI steps that do not necessarily have a package manager on
  // PATH, and the derived worktree borrows this same `node_modules` anyway.
  const vitestBin = join(cwd, 'node_modules', '.bin', 'vitest')
  const result = spawnSync(
    vitestBin,
    [
      'run',
      '--config',
      configFile,
      '--reporter',
      'json',
      '--outputFile',
      reportFile,
      ...(update ? ['--update'] : []),
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        [baselineDirEnvVar]: baselineDir,
        ...(manifest === undefined ? {} : { [manifestEnvVar]: manifest }),
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return { status: result.status ?? 1, output: `${result.stdout}\n${result.stderr}` }
}

interface VitestJsonAssertion {
  readonly fullName?: string
  readonly title?: string
  readonly status?: string
  readonly failureMessages?: readonly string[]
}

const parseAssertions = ({
  reportFile,
  output,
}: {
  reportFile: string
  output: string
}): readonly VitestJsonAssertion[] => {
  if (!existsSync(reportFile)) {
    throw new Error(`[story-gate] Vitest produced no JSON report:\n${output}`)
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
    readonly testResults?: readonly { readonly assertionResults?: readonly VitestJsonAssertion[] }[]
  }
  return (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
}

const classify = (message: string): StoryGateChangeKind => {
  if (message.includes('Expected image dimensions')) return 'dimensions'
  if (message.includes('pixels (ratio')) return 'pixels'
  if (message.includes('toHaveNoViolations') || message.includes('accessibility')) {
    return 'accessibility'
  }
  return 'other'
}

/**
 * Run the gate for one package against one git ref.
 *
 * Two captures are required rather than one: compiled styles are baked into a
 * content-hashed asset, so a single build cannot render both refs. Both sides
 * are therefore captured back to back on the same host, which is also what
 * cancels out the host font environment that makes committed baselines
 * worthless.
 */
export const runStoryGate = async ({
  packageDir,
  baselineRef,
  configFile = 'vitest.gate.config.ts',
  cacheDir,
  refresh = false,
}: StoryGateRunOptions): Promise<StoryGateReport> => {
  const packageRoot = resolve(packageDir)
  const repoRoot = runGit({ args: ['rev-parse', '--show-toplevel'], cwd: packageRoot })
  const baselineSha = runGit({ args: ['rev-parse', `${baselineRef}^{commit}`], cwd: packageRoot })
  const cacheRoot = cacheDir ?? join(repoRoot, 'node_modules', '.cache', 'overeng-story-gate')
  const baselineDir = join(cacheRoot, baselineSha)
  const worktreeDir = join(cacheRoot, `tree-${baselineSha}`)
  const completeMarker = join(baselineDir, '.complete')
  const scratchDir = mkdtempSync(join(tmpdir(), 'story-gate-'))

  if (refresh) rmSync(baselineDir, { recursive: true, force: true })

  if (!existsSync(completeMarker)) {
    if (!existsSync(worktreeDir)) {
      mkdirSync(dirname(worktreeDir), { recursive: true })
      runGit({
        args: ['worktree', 'add', '--detach', '--force', worktreeDir, baselineSha],
        cwd: repoRoot,
      })
    }

    const lockPath = 'pnpm-lock.yaml'
    if (
      readFileSync(join(repoRoot, lockPath), 'utf8') !==
      readFileSync(join(worktreeDir, lockPath), 'utf8')
    ) {
      throw new Error(
        `[story-gate] ${lockPath} differs between HEAD and ${baselineRef}, so the derived worktree cannot borrow the installed dependencies. Install in ${worktreeDir} and re-run.`,
      )
    }
    linkNodeModules({ repoRoot, worktreeDir })

    mkdirSync(baselineDir, { recursive: true })
    const capture = runVitest({
      cwd: join(worktreeDir, relative(repoRoot, packageRoot)),
      configFile,
      baselineDir,
      manifest: undefined,
      reportFile: join(scratchDir, 'baseline-report.json'),
      update: true,
    })
    if (capture.status !== 0) {
      throw new Error(`[story-gate] baseline capture at ${baselineRef} failed:\n${capture.output}`)
    }
    writeFileSync(completeMarker, `${baselineSha}\n`)
  }

  const manifest = join(scratchDir, 'requested.txt')
  const reportFile = join(scratchDir, 'compare-report.json')
  writeFileSync(manifest, '')
  const compare = runVitest({
    cwd: packageRoot,
    configFile,
    baselineDir,
    manifest,
    reportFile,
    update: false,
  })

  const requested = new Set(
    readFileSync(manifest, 'utf8')
      .split('\n')
      .filter((line) => line !== ''),
  )
  const baselineFiles = listPngs(baselineDir)
  const removed = baselineFiles
    .filter((file) => !requested.has(file))
    .map((file) => relative(baselineDir, file))

  const assertions = parseAssertions({ reportFile, output: compare.output })
  const failures = assertions.filter((assertion) => assertion.status === 'failed')
  const added: string[] = []
  const changed: StoryGateChange[] = []
  for (const failure of failures) {
    const story = failure.fullName ?? failure.title ?? '<unnamed>'
    const detail = (failure.failureMessages ?? []).join('\n').trim()
    if (detail.includes('No reference screenshot found')) {
      added.push(story)
    } else {
      changed.push({ story, kind: classify(detail), detail })
    }
  }

  return {
    baselineRef,
    baselineSha,
    baselineDir,
    comparedStories: requested.size,
    added,
    removed,
    changed,
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
  }
}
