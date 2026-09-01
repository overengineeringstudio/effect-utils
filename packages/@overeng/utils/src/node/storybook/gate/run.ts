/**
 * Runner for the story gate: derives baselines from a git ref, captures both
 * sides on one host, and reports every way the story set can move.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { dirname, join, relative, resolve, sep } from 'node:path'

import { excludedStoryMarker } from './constants.ts'
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
  /**
   * Stories already failing at the baseline ref, so not caused by this change.
   * Reported rather than hidden — a package can carry accessibility debt and
   * still need a gate that answers "did I make it worse".
   */
  readonly preExisting: readonly string[]
  /**
   * Stories the compare run asked for that have no baseline image on disk.
   *
   * Derived from the filesystem rather than from test messages, because this is
   * the case that inverted the gate: a story that failed at the baseline
   * produced no screenshot, and subtracting it as `preExisting` made its
   * compare-side failure disappear. With every story in that state the
   * regression list is empty by construction and the gate reports success over
   * a total loss of styling. An uncovered story is never debt.
   */
  readonly uncovered: readonly string[]
  /**
   * Stories that opted out of visual comparison via
   * `parameters.storyGate.unstable`, for surfaces no freeze can settle.
   * Reported so an opt-out stays a visible decision rather than silent absence.
   */
  readonly excluded: readonly string[]
  /** Health of the baseline capture itself. A baseline nothing passed at is not a baseline. */
  readonly baseline: { readonly total: number; readonly passed: number; readonly failed: number }
  /**
   * Stories whose baseline capture disagreed with itself.
   *
   * The baseline tree is captured twice and the second capture is the one kept,
   * so any story whose two captures differ is nondeterministic under this
   * harness and cannot support a conclusion either way. Named rather than
   * absorbed: a story that differs from itself would otherwise satisfy any
   * "these two things differ" assertion vacuously.
   */
  readonly selfInconsistent: readonly string[]
  /**
   * Whether the theme projects actually render differently.
   *
   * Counted over the self-consistent stories only, for the reason above. The
   * defect this exists for: a Storybook theme toolbar whose global never
   * reached the element the overrides were keyed on, so both theme projects
   * captured the same palette twice and the gate reported a green
   * double-coverage over a matrix dimension that did not vary at all. A pass
   * signal cannot detect that; only a count can.
   *
   * What it does NOT establish: that the axis varies *correctly*. The count is
   * unchanged if light and dark are swapped wholesale. Comparing rendered
   * values against expected ones is a separate check.
   */
  readonly themeAxis: {
    /** Project names compared, in capture order. */
    readonly projects: readonly string[]
    /** Stories present in every project and consistent with themselves. */
    readonly comparable: number
    /** Of those, how many render differently across at least one project pair. */
    readonly differing: number
  }
  readonly ok: boolean
}

/**
 * The verdict, separated from the run so it is testable without a browser.
 *
 * Zero passes at the baseline is the one case the machine refuses outright:
 * it means the comparison had nothing to compare against, and an empty
 * regression list over it is meaningless rather than clean. Everything between
 * — a degraded but informative baseline — is surfaced in the counts and left to
 * a human, because a fraction threshold set wrong rejects the informative case
 * along with the broken one.
 *
 * A collapsed theme axis is refused for the same reason and it is not the same
 * failure: every earlier one was a pass signal defined as the absence of a
 * failure marker, whereas this is a matrix dimension that produced two projects
 * and compared them and varied in neither. `themeVaries: false` is how a target
 * that legitimately ships one colour scheme declares itself — without that, the
 * guard fails a correct target for a property of the target and someone turns
 * it off.
 */
export const isStoryGateOk = ({
  added,
  removed,
  changed,
  uncovered,
  baseline,
  themeAxis,
  themeVaries = true,
}: Pick<
  StoryGateReport,
  'added' | 'removed' | 'changed' | 'uncovered' | 'baseline' | 'themeAxis'
> & {
  readonly themeVaries?: boolean
}): boolean =>
  added.length === 0 &&
  removed.length === 0 &&
  changed.length === 0 &&
  uncovered.length === 0 &&
  baseline.passed > 0 &&
  (themeVaries === false ||
    themeAxis.projects.length < 2 ||
    themeAxis.comparable === 0 ||
    themeAxis.differing > 0)

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
  /**
   * Whether this target's theme projects are expected to render differently.
   *
   * Set `false` only for a target that legitimately ships a single colour
   * scheme; the run then reports the observed count without demanding it be
   * non-zero. Measured shapes this distinguishes: 38 of 39 comparable stories
   * differ across schemes on a two-scheme target, 0 of 57 on a single-scheme
   * one — the second is correct and must not be failed.
   *
   * @default true
   */
  readonly themeVaries?: boolean
}

const runGit = ({ args, cwd }: { args: readonly string[]; cwd: string }): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`[story-gate] git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

const listPngs = (root: string): string[] => {
  if (existsSync(root) === false) return []
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => join(entry.parentPath, entry.name))
}

/**
 * Every capture in `root`, keyed by `<project>/<story path>` and valued by
 * content hash.
 *
 * Hashes rather than buffers: a full library is ~950 PNGs across two projects
 * and every one of them is read exactly once here, then compared as 40 bytes.
 */
const hashCaptures = (root: string): Map<string, string> => {
  const captures = new Map<string, string>()
  for (const file of listPngs(root)) {
    captures.set(relative(root, file), createHash('sha1').update(readFileSync(file)).digest('hex'))
  }
  return captures
}

/** Split `<project>/<rest>` — the layout `resolveScreenshotPath` writes. */
const splitCaptureKey = (key: string): { project: string; story: string } | undefined => {
  const separator = key.indexOf(sep)
  if (separator <= 0) return undefined
  return { project: key.slice(0, separator), story: key.slice(separator + 1) }
}

/**
 * Count stories that render differently across theme projects.
 *
 * `selfInconsistent` is subtracted first and that is the whole point of taking
 * it as an argument: a story that differs from itself differs across projects
 * for the wrong reason and would satisfy this assertion vacuously. On a suite
 * with any nondeterminism, counting the raw set would report a healthy axis on
 * a broken one.
 *
 * Only stories captured by EVERY project are counted. A story present in one
 * project and missing from another is not evidence about variation; it is a
 * different defect, and `added`/`removed`/`uncovered` already carry it.
 */
const countThemeVariation = ({
  captures,
  selfInconsistent,
}: {
  captures: Map<string, string>
  selfInconsistent: ReadonlySet<string>
}): StoryGateReport['themeAxis'] => {
  const byStory = new Map<string, Map<string, string>>()
  const projects: string[] = []
  for (const [key, hash] of captures) {
    const split = splitCaptureKey(key)
    if (split === undefined || selfInconsistent.has(key) === true) continue
    if (projects.includes(split.project) === false) projects.push(split.project)
    const perProject = byStory.get(split.story) ?? new Map<string, string>()
    perProject.set(split.project, hash)
    byStory.set(split.story, perProject)
  }

  let comparable = 0
  let differing = 0
  for (const perProject of byStory.values()) {
    if (perProject.size !== projects.length) continue
    comparable += 1
    if (new Set(perProject.values()).size > 1) differing += 1
  }
  return { projects, comparable, differing }
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
    if (existsSync(source) === false || existsSync(target) === true) continue
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
      ...(update === true ? ['--update'] : []),
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
  if (existsSync(reportFile) === false) {
    throw new Error(`[story-gate] Vitest produced no JSON report:\n${output}`)
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
    readonly testResults?: readonly { readonly assertionResults?: readonly VitestJsonAssertion[] }[]
  }
  return (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
}

const classify = (message: string): StoryGateChangeKind => {
  if (message.includes('Expected image dimensions') === true) return 'dimensions'
  if (message.includes('pixels (ratio') === true) return 'pixels'
  if (
    message.includes('toHaveNoViolations') === true ||
    message.includes('accessibility') === true
  ) {
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
  themeVaries = true,
}: StoryGateRunOptions): Promise<StoryGateReport> => {
  const packageRoot = resolve(packageDir)
  const repoRoot = runGit({ args: ['rev-parse', '--show-toplevel'], cwd: packageRoot })
  const baselineSha = runGit({ args: ['rev-parse', `${baselineRef}^{commit}`], cwd: packageRoot })
  const cacheRoot = cacheDir ?? join(repoRoot, 'node_modules', '.cache', 'overeng-story-gate')
  const baselineDir = join(cacheRoot, baselineSha)
  const worktreeDir = join(cacheRoot, `tree-${baselineSha}`)
  const completeMarker = join(baselineDir, '.complete')
  const scratchDir = mkdtempSync(join(tmpdir(), 'story-gate-'))

  if (refresh === true) rmSync(baselineDir, { recursive: true, force: true })

  if (existsSync(completeMarker) === false) {
    if (existsSync(worktreeDir) === false) {
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

    // The baseline tree is captured TWICE and the second capture is the one
    // kept. Two reasons, both measured.
    //
    // First, it establishes which stories are comparable at all. A story whose
    // two captures of one unchanged tree disagree is nondeterministic, and any
    // later conclusion drawn about it — changed, unchanged, theme-varying — is
    // noise wearing a verdict. Measured shapes: an element present in one
    // capture and absent in the next accounted for 9 of 70 captures on one
    // surface, and 17 of 212 on another with an independent instrument.
    //
    // Second, it removes a cold/warm asymmetry the design otherwise builds in.
    // The baseline is captured in a freshly derived worktree while the compare
    // capture runs warm, and the first capture into a cold cache was measured
    // to differ from every later one deterministically — reproducing to the
    // pixel, 689 and 693 pixels on two stories, at a fractionally-positioned
    // border hairline. Keeping the second capture makes both sides warm, so the
    // comparator's tolerance is spent on real host variance rather than on an
    // artefact we put there ourselves.
    const probeDir = join(cacheRoot, `probe-${baselineSha}`)
    rmSync(probeDir, { recursive: true, force: true })
    mkdirSync(probeDir, { recursive: true })
    mkdirSync(baselineDir, { recursive: true })
    const baselineReportFile = join(baselineDir, 'baseline-report.json')
    const captureCwd = join(worktreeDir, relative(repoRoot, packageRoot))
    runVitest({
      cwd: captureCwd,
      configFile,
      baselineDir: probeDir,
      manifest: undefined,
      reportFile: join(probeDir, 'probe-report.json'),
      update: true,
    })
    const capture = runVitest({
      cwd: captureCwd,
      configFile,
      baselineDir,
      manifest: undefined,
      reportFile: baselineReportFile,
      update: true,
    })
    // A non-zero exit is expected and not fatal here. Under `--update` the
    // screenshots are written regardless, and the ref may legitimately carry
    // failing stories — an accessibility violation that already existed is not
    // something this change caused. What matters is that the capture produced
    // a report; the compare phase subtracts whatever failed on both sides.
    if (existsSync(baselineReportFile) === false) {
      throw new Error(`[story-gate] baseline capture at ${baselineRef} failed:\n${capture.output}`)
    }
    const probeCaptures = hashCaptures(probeDir)
    const selfInconsistent = [...hashCaptures(baselineDir)]
      .filter(([key, hash]) => probeCaptures.has(key) === true && probeCaptures.get(key) !== hash)
      .map(([key]) => key)
    writeFileSync(join(baselineDir, 'self-inconsistent.json'), JSON.stringify(selfInconsistent))
    rmSync(probeDir, { recursive: true, force: true })
    writeFileSync(completeMarker, `${baselineSha}\n`)
  }

  const baselineAssertions = parseAssertions({
    reportFile: join(baselineDir, 'baseline-report.json'),
    output: '',
  })
  const baselineFailures = baselineAssertions.filter((assertion) => assertion.status === 'failed')
  const baseline = {
    total: baselineAssertions.length,
    passed: baselineAssertions.length - baselineFailures.length,
    failed: baselineFailures.length,
  }
  const preExisting = new Set(
    baselineFailures.map((assertion) => assertion.fullName ?? assertion.title ?? '<unnamed>'),
  )

  // Read back rather than recomputed, because the baseline is cached across
  // runs and the probe capture that produced this only happens when the cache
  // is cold. An older cache entry predating this file yields an empty set,
  // which is the honest answer: nothing was excluded because nothing was
  // measured.
  const selfInconsistentPath = join(baselineDir, 'self-inconsistent.json')
  const selfInconsistent: string[] = existsSync(selfInconsistentPath)
    ? (JSON.parse(readFileSync(selfInconsistentPath, 'utf8')) as string[])
    : []
  const themeAxis = countThemeVariation({
    captures: hashCaptures(baselineDir),
    selfInconsistent: new Set(selfInconsistent),
  })

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
    .filter((file) => requested.has(file) === false)
    .map((file) => relative(baselineDir, file))
  const uncovered = [...requested]
    .filter((file) => existsSync(file) === false)
    .map((file) => relative(baselineDir, file))

  const excluded = compare.output
    .split('\n')
    .filter((line) => line.includes(excludedStoryMarker) === true)
    .map((line) =>
      line.slice(line.indexOf(excludedStoryMarker) + excludedStoryMarker.length).trim(),
    )

  const assertions = parseAssertions({ reportFile, output: compare.output })
  const failures = assertions.filter((assertion) => assertion.status === 'failed')
  const added: string[] = []
  const changed: StoryGateChange[] = []
  for (const failure of failures) {
    const story = failure.fullName ?? failure.title ?? '<unnamed>'
    const detail = (failure.failureMessages ?? []).join('\n').trim()
    // Missing-reference is checked BEFORE the pre-existing skip on purpose: a
    // story with no baseline image cannot be known-failing debt, and letting
    // the skip run first is precisely what swallowed it.
    if (detail.includes('No existing reference screenshot found') === true) {
      added.push(story)
    } else if (preExisting.has(story) === true) {
      continue
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
    preExisting: [...preExisting],
    uncovered,
    excluded: [...new Set(excluded)],
    baseline,
    selfInconsistent,
    themeAxis,
    ok: isStoryGateOk({
      added,
      removed,
      changed,
      uncovered,
      baseline,
      themeAxis,
      themeVaries,
    }),
  }
}
