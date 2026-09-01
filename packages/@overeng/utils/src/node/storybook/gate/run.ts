/**
 * Runner for the story gate: derives baselines from a git ref, captures both
 * sides on one host, and reports every way the story set can move.
 *
 * KNOWN STRUCTURAL LIMIT, stated because it shapes what any verdict here can
 * mean. Capture and comparison are welded into one command: one invocation
 * captures the baseline tree twice and the compare tree once, then compares.
 * So this runner cannot produce a self-consistency pair for the compare side,
 * and a protocol wanting one needs a second invocation with `--ref <after-sha>`.
 * `captureSets` reports the asymmetry rather than leaving the report to read as
 * complete under a protocol it does not implement.
 *
 * Separating capture from comparison — capture writes a named directory,
 * comparison is an offline pass over directories — is the real repair, and it
 * would make "this claim rests on these capture sets" expressible directly
 * instead of narrated. It is deliberately NOT attempted here: this change
 * repairs the readiness signal, and one semantic change at a time is what keeps
 * a measurement attributable to the thing that caused it.
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import {
  excludedStoryMarker,
  settledStoryMarker,
  type StorySettleRecord,
  storySettleConfig,
  unsettledStoryMarker,
} from './constants.ts'
import { baselineDirEnvVar, manifestEnvVar } from './project.ts'

/** How a story's render differs from the baseline ref. */
export type StoryGateChangeKind = 'pixels' | 'dimensions' | 'accessibility' | 'other'

/** One story that did not reproduce the baseline. */
export interface StoryGateChange {
  readonly story: string
  readonly kind: StoryGateChangeKind
  readonly detail: string
}

/**
 * What a tree contained when it was captured.
 *
 * Scoped deliberately, because an over-broad hash is a guard that cries wolf
 * and the first thing anyone does with one of those is switch it off. Tracked
 * content is covered exactly and cheaply by `head` plus a hash of the diff
 * against it; untracked files are included only under the package's source and
 * story roots, which is where a file that can change a render would have to
 * appear. A scratch script sitting beside the package is therefore not
 * contamination, and a new untracked story file is.
 *
 * `entries` exists so a refusal can say WHICH entry moved. A guard whose
 * refusal cannot be diagnosed gets bypassed, which is the same lesson as a
 * summary that could not say its baseline was unusable, applied before the fact
 * rather than after.
 */
export interface TreeIdentity {
  /** Commit the tree was on. */
  readonly head: string
  /** Combined digest over every entry — the value that is actually compared. */
  readonly digest: string
  /** Human-readable statement of what was hashed. */
  readonly scope: string
  /** Per-entry hashes, keyed by a label naming what the entry is. */
  readonly entries: Readonly<Record<string, string>>
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
   * Stories that opted out of visual comparison BY DECLARATION, via
   * `parameters.storyGate.unstable`, for surfaces no freeze can settle.
   * Reported so an opt-out stays a visible decision rather than silent absence.
   *
   * Distinct from {@link StoryGateReport.unsettled}, which is the same
   * mechanical effect reached by observation rather than by declaration. The
   * two are never merged: this list is a set of reviewed decisions recorded in
   * source, and an unreviewed exclusion hiding inside it would be invisible in
   * exactly the way the gate's other guards exist to prevent.
   */
  readonly excluded: readonly string[]
  /**
   * Stories the settle signal watched and never saw reach a quiet DOM.
   *
   * Excluded from the visual comparison with a stated reason and an observed
   * shape history, and counted, because the mechanism's value is in the
   * RECORDING more than in the waiting. A story that never settles is still
   * captured, still named, and still attributable; the failure mode being
   * removed is the one where such a story simply disappears from the run and
   * the summary stays green over a story nobody compared.
   *
   * These stories never call `toMatchScreenshot`, so they resolve no baseline
   * path and enter no manifest — which is what keeps them out of `preExisting`,
   * where a baseline-side failure would silently subtract its own compare-side
   * failure.
   */
  readonly unsettled: readonly StorySettleRecord[]
  /**
   * What the settle signal cost, measured rather than assumed.
   *
   * `bound` is reported alongside the observed spread because the bound is a
   * bound and not a target: an ordinary story satisfies the predicate on its
   * first three polls, so quoting the ceiling as per-story cost would overstate
   * it by more than an order of magnitude. `settledStories` is a positive count
   * emitted per story by the browser, not inferred from the absence of failure
   * markers — a harness that never launched cannot fake it.
   */
  readonly settle: {
    readonly settledStories: number
    readonly unsettledStories: number
    readonly boundMs: number
    readonly minMs: number
    readonly medianMs: number
    readonly maxMs: number
    readonly totalMs: number
  }
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
   * Stories that rendered differently AND were already known nondeterministic,
   * so the difference says nothing.
   *
   * Split out of `changed` rather than left in it. Measured on an identical
   * tree with nothing changed: 21 stories reported as `changed`, of which 19
   * were already in `selfInconsistent` — the gate computed the exclusion set,
   * printed its size, and then reported its members as regressions anyway.
   *
   * Kept as its own list instead of silently filtered, so the report can state
   * how much of the difference was noise the probe had already identified. A
   * story here needs its nondeterminism fixed before the gate can say anything
   * about it; it is not evidence of a regression, and not evidence of its
   * absence either.
   */
  readonly nondeterministic: readonly string[]
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
  /**
   * Which capture sets each verdict rests on, and how many times each side was
   * captured.
   *
   * Present because the asymmetry is real and was previously unstated: ONE
   * invocation captures the baseline tree TWICE — that pair is where
   * `selfInconsistent` comes from — and the compare tree exactly ONCE. So a
   * single run yields a before-pair and an after-single, and the report used to
   * read as complete under a protocol that assumed pairs on both sides.
   *
   * The deeper reason this has to be said rather than fixed here: capture and
   * comparison are welded into one command, so the gate cannot offer an
   * after-pair without a second invocation. Decoupling them is the real repair
   * and is deliberately not attempted in this change — see the module note.
   */
  readonly captureSets: {
    readonly baselineDir: string
    readonly baselineCaptures: number
    readonly compareCaptures: number
  }
  /**
   * Identity of each tree at the moment it was captured.
   *
   * Asserts the assumption that a capture set came from ONE tree, rather than
   * trusting whoever ran it to have avoided editing mid-run. The failure this
   * closes is invisible to every other guard here: if source changes land while
   * a same-tree-twice pair is in flight, HMR recompiles and BOTH captures span
   * both trees, so they agree with each other while both are wrong.
   * Self-consistency cannot see contamination common to both samples.
   */
  readonly treeIdentity: {
    readonly baseline: TreeIdentity
    readonly compare: TreeIdentity
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
 *
 * A story that never settled is refused too, and the asymmetry with
 * `parameters.storyGate.unstable` is the point rather than an inconsistency. A
 * declared opt-out is a reviewed decision, so it passes; a failure to settle is
 * an UNREVIEWED one the harness discovered, and letting it pass would mean the
 * gate reporting green over a story it did not compare. The remedy is visible
 * and cheap — fix the story, or declare it unstable and put the decision on the
 * record — which is exactly the choice `uncovered` already forces.
 */
export const isStoryGateOk = ({
  added,
  removed,
  changed,
  uncovered,
  unsettled,
  baseline,
  themeAxis,
  themeVaries = true,
}: Pick<
  StoryGateReport,
  'added' | 'removed' | 'changed' | 'uncovered' | 'unsettled' | 'baseline' | 'themeAxis'
> & {
  readonly themeVaries?: boolean
}): boolean =>
  added.length === 0 &&
  removed.length === 0 &&
  changed.length === 0 &&
  uncovered.length === 0 &&
  unsettled.length === 0 &&
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
  /**
   * Package-relative directories whose UNTRACKED files count as part of the
   * tree's identity.
   *
   * These are the places a file that can change a render would have to appear.
   * Everything else untracked is excluded so that a scratch script beside the
   * package does not refuse an otherwise valid comparison — a guard that cries
   * wolf gets switched off, and then it protects nothing.
   *
   * @default ['src', 'stories', '.storybook']
   */
  readonly sourceRoots?: readonly string[]
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
      // BOTH reporters, and the json one is named in `--outputFile.json` so it
      // still lands in a file. `--reporter json` ALONE replaces the console
      // reporter, and the json report has no field for a browser-side
      // `console.info` — so the story-gate markers, which are the only channel
      // carrying "why this story was not compared", were being discarded before
      // the runner ever saw them. Every exclusion the browser reports travels on
      // the default reporter's stream; the JSON file carries only assertions.
      '--reporter',
      'default',
      '--reporter',
      'json',
      `--outputFile.json=${reportFile}`,
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
  /**
   * Basename of the story file the assertion came from.
   *
   * Carried because `fullName` is the BARE story name — measured: `With
   * Values`, not `Forms/AriaSchemaForm > With Values` — so it is only unique
   * within a file. A library with `Default` in twenty story files has twenty
   * assertions called `Default`, and any set keyed on the name alone silently
   * conflates them.
   */
  readonly file?: string
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
    readonly testResults?: readonly {
      readonly name?: string
      readonly assertionResults?: readonly VitestJsonAssertion[]
    }[]
  }
  return (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((assertion) =>
      file.name === undefined ? assertion : { ...assertion, file: basename(file.name) },
    ),
  )
}

/**
 * Storybook's story-id slug for a story name.
 *
 * Needed because the two sides of this join speak different namespaces: a
 * capture key ends in the story ID (`components-numberfield--with-hint`) while a
 * Vitest assertion carries the bare story NAME (`With Hint`). Storybook derives
 * the id's suffix from the name by this same slugging, so slugging the name is
 * what lets one be looked up by the other.
 */
export const slugStoryName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Key a story by its file AND its slug, never by name alone.
 *
 * `fullName` is unique only within a story file, so a name-only key conflates
 * every `Default` in the library. Conflating them here would let one story's
 * self-inconsistency suppress a DIFFERENT story's real regression — a false
 * green, which is worse than the noise this subtraction removes.
 */
export const storyKey = ({ file, slug }: { file: string; slug: string }): string => `${file}::${slug}`

/**
 * The stories the baseline probe already proved nondeterministic, keyed to join
 * against Vitest assertions.
 *
 * Capture keys look like
 * `<project>/<dir>/<Foo.stories.tsx>/<story-id>.png`, so the story file is the
 * penultimate segment and the id is the basename.
 */
export const selfInconsistentStoryKeys = (captureKeys: readonly string[]): ReadonlySet<string> => {
  const keys = new Set<string>()
  for (const captureKey of captureKeys) {
    const segments = captureKey.split(sep)
    const png = segments.at(-1)
    const file = segments.at(-2)
    if (png === undefined || file === undefined) continue
    const id = png.replace(/\.png$/, '')
    // The id is `<title-slug>--<name-slug>`; only the name half can be
    // reconstructed from a Vitest assertion, so that is what is keyed.
    const slug = id.includes('--') ? (id.split('--').at(-1) ?? id) : id
    keys.add(storyKey({ file, slug }))
  }
  return keys
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
 * Pull the settle records a run's browser side emitted for one marker.
 *
 * The payload is JSON rather than a delimited string so that a story name
 * containing the delimiter cannot corrupt a record — the name is chosen by
 * whoever wrote the story, and a parser that a story title can break is a
 * channel that loses its own contents.
 *
 * A malformed line is collected as a defect rather than dropped. Silently
 * skipping it would reintroduce, in the reporting layer, exactly the
 * disappearance the settle signal exists to prevent.
 */
const parseSettleRecords = ({
  output,
  marker,
}: {
  output: string
  marker: string
}): { readonly records: readonly StorySettleRecord[]; readonly malformed: readonly string[] } => {
  const records: StorySettleRecord[] = []
  const malformed: string[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    const at = line.indexOf(marker)
    if (at === -1) continue
    const payload = line.slice(at + marker.length).trim()
    try {
      const record = JSON.parse(payload) as StorySettleRecord
      // One story can emit twice when a run retries it; the last record wins
      // and the story is counted once, because a count that double-counts a
      // retry is not a count of stories.
      if (seen.has(record.id) === true) {
        records[records.findIndex((existing) => existing.id === record.id)] = record
        continue
      }
      seen.add(record.id)
      records.push(record)
    } catch {
      malformed.push(payload.slice(0, 200))
    }
  }
  return { records, malformed }
}

/** Cost of the settle signal over one run's settled stories. */
const summariseSettle = ({
  settled,
  unsettled,
}: {
  settled: readonly StorySettleRecord[]
  unsettled: readonly StorySettleRecord[]
}): StoryGateReport['settle'] => {
  const durations = settled.map((record) => record.elapsedMs).sort((a, b) => a - b)
  const median = durations.length === 0 ? 0 : (durations[durations.length >> 1] ?? 0)
  return {
    settledStories: settled.length,
    unsettledStories: unsettled.length,
    boundMs: storySettleConfig.boundMs,
    minMs: durations[0] ?? 0,
    medianMs: median,
    maxMs: durations[durations.length - 1] ?? 0,
    totalMs: [...durations, ...unsettled.map((record) => record.elapsedMs)].reduce(
      (sum, value) => sum + value,
      0,
    ),
  }
}

/**
 * Files that can change a render but are not tracked, so a content hash is the
 * only way to notice them.
 *
 * Restricted to the package's source and story roots on purpose. Hashing every
 * untracked file would refuse a comparison over a scratch script no story
 * imports, and a guard that refuses legitimate runs gets switched off — which
 * costs more than the case it was protecting against.
 */
const untrackedSourceFiles = ({
  repoRoot,
  packageRoot,
  sourceRoots,
}: {
  repoRoot: string
  packageRoot: string
  sourceRoots: readonly string[]
}): readonly string[] => {
  const present = sourceRoots
    .map((root) => join(packageRoot, root))
    .filter((root) => existsSync(root) === true)
    .map((root) => relative(repoRoot, root))
  if (present.length === 0) return []
  return runGit({
    args: ['ls-files', '--others', '--exclude-standard', '--', ...present],
    cwd: repoRoot,
  })
    .split('\n')
    .filter((line) => line !== '')
}

/**
 * Identity of a tree at one instant, scoped to what can change a render.
 *
 * Tracked content is captured exactly by `HEAD` plus a per-path hash of the
 * diff against it — cheap, because git already knows which paths moved — and
 * untracked files are added only under the package's source and story roots.
 */
const readTreeIdentity = ({
  repoRoot,
  packageRoot,
  sourceRoots,
}: {
  repoRoot: string
  packageRoot: string
  sourceRoots: readonly string[]
}): TreeIdentity => {
  const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: repoRoot })
  const entries: Record<string, string> = { HEAD: head }

  const changed = runGit({ args: ['diff', 'HEAD', '--name-only'], cwd: repoRoot })
    .split('\n')
    .filter((line) => line !== '')
  for (const path of changed) {
    const diff = runGit({ args: ['diff', 'HEAD', '--', path], cwd: repoRoot })
    entries[`tracked:${path}`] = createHash('sha1').update(diff).digest('hex')
  }

  for (const path of untrackedSourceFiles({ repoRoot, packageRoot, sourceRoots })) {
    const absolute = join(repoRoot, path)
    entries[`untracked:${path}`] = existsSync(absolute)
      ? createHash('sha1').update(readFileSync(absolute)).digest('hex')
      : 'absent'
  }

  const digest = createHash('sha1')
    .update(
      Object.keys(entries)
        .sort()
        .map((key) => `${key}=${entries[key]}`)
        .join('\n'),
    )
    .digest('hex')

  return {
    head,
    digest,
    scope: `tracked content at ${repoRoot} plus untracked files under ${sourceRoots
      .map((root) => join(relative(repoRoot, packageRoot), root))
      .join(', ')}`,
    entries,
  }
}

/**
 * Name every entry that moved between two identities.
 *
 * The refusal has to be diagnosable or it will be bypassed, so this reports the
 * scope it hashed, the entry count, and each differing path with both sides —
 * never just "the tree changed".
 */
const describeIdentityDrift = ({
  before,
  after,
}: {
  before: TreeIdentity
  after: TreeIdentity
}): string => {
  const keys = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort()
  const drifted = keys
    .filter((key) => before.entries[key] !== after.entries[key])
    .map(
      (key) =>
        `    ${key}: ${before.entries[key] ?? '<absent>'} -> ${after.entries[key] ?? '<absent>'}`,
    )
  return [
    `  scope: ${before.scope}`,
    `  entries hashed: ${Object.keys(before.entries).length} before, ${Object.keys(after.entries).length} after`,
    `  differing entries (${drifted.length}):`,
    ...drifted,
  ].join('\n')
}

/**
 * Refuse a capture set whose tree moved while it was being captured.
 *
 * This is the one contamination the same-tree-twice check structurally cannot
 * see: if source changes land mid-pair, HMR recompiles and both captures span
 * both trees, so they agree with each other while both are invalid. A
 * self-consistency check is blind to error common to both samples, so the
 * assumption has to be asserted rather than assumed.
 */
const assertTreeUnchanged = ({
  before,
  after,
  what,
}: {
  before: TreeIdentity
  after: TreeIdentity
  what: string
}): void => {
  if (before.digest === after.digest) return
  throw new Error(
    `[story-gate] the tree moved while ${what} was being captured, so that capture set spans two trees and cannot be compared.\n${describeIdentityDrift(
      { before, after },
    )}\n  Re-run without editing source during the capture.`,
  )
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
  sourceRoots = ['src', 'stories', '.storybook'],
}: StoryGateRunOptions): Promise<StoryGateReport> => {
  const packageRoot = resolve(packageDir)
  const repoRoot = runGit({ args: ['rev-parse', '--show-toplevel'], cwd: packageRoot })
  const baselineSha = runGit({ args: ['rev-parse', `${baselineRef}^{commit}`], cwd: packageRoot })
  const cacheRoot = cacheDir ?? join(repoRoot, 'node_modules', '.cache', 'overeng-story-gate')
  const baselineDir = join(cacheRoot, baselineSha)
  const worktreeDir = join(cacheRoot, `tree-${baselineSha}`)
  const completeMarker = join(baselineDir, '.complete')
  const identityPath = join(baselineDir, 'tree-identity.json')
  const settlePath = join(baselineDir, 'unsettled.json')
  const scratchDir = mkdtempSync(join(tmpdir(), 'story-gate-'))

  /**
   * The baseline pair's identity covers BOTH trees, not just the worktree it
   * renders from. The derived worktree borrows the main tree's `node_modules`
   * by symlink, so an edit to a workspace package in the main tree reaches the
   * baseline capture through that link — which is precisely how a capture set
   * ends up spanning two trees while looking like it came from one.
   */
  const baselinePairIdentity = (): TreeIdentity => {
    const worktree = readTreeIdentity({
      repoRoot: worktreeDir,
      packageRoot: join(worktreeDir, relative(repoRoot, packageRoot)),
      sourceRoots,
    })
    const linked = readTreeIdentity({ repoRoot, packageRoot, sourceRoots })
    return {
      head: worktree.head,
      digest: createHash('sha1').update(`${worktree.digest}\n${linked.digest}`).digest('hex'),
      scope: `${worktree.scope}; plus the linked main tree: ${linked.scope}`,
      entries: Object.fromEntries([
        ...Object.entries(worktree.entries).map(([key, value]) => [`worktree/${key}`, value]),
        ...Object.entries(linked.entries).map(([key, value]) => [`linked/${key}`, value]),
      ]),
    }
  }

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
    const identityBefore = baselinePairIdentity()
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
    // Asserted AFTER the pair, not before it: the point is that neither capture
    // spanned an edit, and only a reading taken once both are on disk can say
    // that. This is the guard the same-tree-twice check cannot be, because a
    // recompile mid-pair contaminates both halves in the same direction and
    // leaves them agreeing with each other.
    const identityAfter = baselinePairIdentity()
    assertTreeUnchanged({
      before: identityBefore,
      after: identityAfter,
      what: `the baseline pair at ${baselineRef}`,
    })
    writeFileSync(identityPath, JSON.stringify(identityAfter))

    const baselineSettle = parseSettleRecords({
      output: capture.output,
      marker: unsettledStoryMarker,
    })
    writeFileSync(settlePath, JSON.stringify(baselineSettle.records))

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
  const compareIdentityBefore = readTreeIdentity({ repoRoot, packageRoot, sourceRoots })
  const compare = runVitest({
    cwd: packageRoot,
    configFile,
    baselineDir,
    manifest,
    reportFile,
    update: false,
  })
  const compareIdentity = readTreeIdentity({ repoRoot, packageRoot, sourceRoots })
  assertTreeUnchanged({
    before: compareIdentityBefore,
    after: compareIdentity,
    what: 'the compare tree',
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

  const settledRecords = parseSettleRecords({
    output: compare.output,
    marker: settledStoryMarker,
  })
  const unsettledRecords = parseSettleRecords({
    output: compare.output,
    marker: unsettledStoryMarker,
  })
  // A marker the runner could not parse is a defect in the channel, and a
  // channel that loses records silently is the failure this whole mechanism
  // exists to remove. Surfaced as an unsettled entry with its own reason rather
  // than dropped, so the count stays honest even when the parse fails.
  const malformed = [...settledRecords.malformed, ...unsettledRecords.malformed].map(
    (payload): StorySettleRecord => ({
      id: `<unparseable> ${payload}`,
      name: '<unparseable settle record>',
      elapsedMs: 0,
      shapes: [],
      reason: 'shape-never-quiet',
    }),
  )
  const unsettled = [...unsettledRecords.records, ...malformed]
  // A story unsettled at the BASELINE produced no reference image by
  // construction, so its compare-side assertion fails with "no existing
  // reference" and would be reported as `added` — an existing story labelled as
  // new, which is a wrong verdict rather than a noisy one. Named for what it is
  // instead. This is also the racy-settler case: a story that settles on one
  // run and not the other is non-comparable, and saying so is the honest answer.
  const unsettledAtBaseline: readonly StorySettleRecord[] = existsSync(settlePath)
    ? (JSON.parse(readFileSync(settlePath, 'utf8')) as StorySettleRecord[])
    : []
  const unsettledNames = new Set(
    [...unsettled, ...unsettledAtBaseline].flatMap((record) => [record.id, record.name]),
  )

  // The exclusion set the probe capture already computed, finally applied to
  // the thing it exists for. Measured on an IDENTICAL tree with nothing
  // changed: 21 stories reported as `changed`, 19 of which the gate's own probe
  // had already named self-inconsistent. It identified them, printed the count
  // in its summary, and then reported them as regressions anyway — so every
  // conversion PR on every target opened with a changed-list of pure noise the
  // machinery already knew how to filter.
  //
  // A story that differs from ITSELF cannot support a `changed` verdict either
  // way; that is the same reasoning the theme-variation count already applies,
  // and it was only ever applied there.
  const selfInconsistentKeys = selfInconsistentStoryKeys(selfInconsistent)
  const nondeterministic: string[] = []

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
      if (unsettledNames.has(story) === true) continue
      added.push(story)
    } else if (preExisting.has(story) === true) {
      continue
    } else if (
      failure.file !== undefined &&
      selfInconsistentKeys.has(storyKey({ file: failure.file, slug: slugStoryName(story) })) ===
        true
    ) {
      // Excluded, not dropped: it moves to its own list so the summary can say
      // how much of the changed-list was noise the probe had already found.
      nondeterministic.push(story)
    } else {
      changed.push({ story, kind: classify(detail), detail })
    }
  }

  const settle = summariseSettle({ settled: settledRecords.records, unsettled })

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
    unsettled: [
      ...unsettled,
      ...unsettledAtBaseline.filter(
        (record) => unsettled.some((current) => current.id === record.id) === false,
      ),
    ],
    settle,
    baseline,
    selfInconsistent,
    nondeterministic,
    themeAxis,
    captureSets: { baselineDir, baselineCaptures: 2, compareCaptures: 1 },
    treeIdentity: {
      baseline: existsSync(identityPath)
        ? (JSON.parse(readFileSync(identityPath, 'utf8')) as TreeIdentity)
        : { head: baselineSha, digest: 'unrecorded', scope: 'not recorded by this cache entry', entries: {} },
      compare: compareIdentity,
    },
    ok: isStoryGateOk({
      added,
      removed,
      changed,
      uncovered,
      unsettled,
      baseline,
      themeAxis,
      themeVaries,
    }),
  }
}
