/**
 * Runnable entry point for the story gate.
 *
 * Without this the gate is a library function and every target has to write its
 * own driver, which is the same per-target duplication the shared layer exists
 * to remove — and a check nobody can run is not the "working visual check" R08
 * asks for.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { runStoryGate } from './run.ts'

const usage = `Usage: gate [--package <dir>] [--ref <git-ref>] [--refresh] [--single-scheme]

  --package        package directory holding .storybook (default: cwd)
  --ref            git ref supplying the baseline (default: HEAD)
  --refresh        re-derive the baseline even if one is cached
  --single-scheme  this target ships one colour scheme, so theme projects are
                   expected to render identically and that is not a failure
`

const readFlag = ({
  argv,
  flag,
}: {
  argv: readonly string[]
  flag: string
}): string | undefined => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/** Run the gate and print a report; resolves to the process exit code. */
export const runStoryGateCli = async (argv: readonly string[]): Promise<number> => {
  if (argv.includes('--help') === true) {
    process.stdout.write(usage)
    return 0
  }

  const report = await runStoryGate({
    packageDir: readFlag({ argv, flag: '--package' }) ?? process.cwd(),
    baselineRef: readFlag({ argv, flag: '--ref' }) ?? 'HEAD',
    refresh: argv.includes('--refresh'),
    themeVaries: argv.includes('--single-scheme') === false,
  })

  // Capture liveness comes FIRST, before any pass/fail number. The failure
  // signature this project keeps hitting is zero-work-plus-zero-errors: a
  // harness that never launched a browser emits no failures and reads as
  // perfect. A positive settled count, emitted per story by the browser itself,
  // is the only thing that distinguishes "everything settled" from "nothing
  // ran", so it is asserted before anything is interpreted.
  const liveness = [
    '=== capture liveness ===',
    `  settled ${report.settle.settledStories} · never settled ${report.settle.unsettledStories} · opted out ${report.excluded.length} · compared ${report.comparedStories}`,
    `  settle cost per story: min ${report.settle.minMs}ms · median ${report.settle.medianMs}ms · max ${report.settle.maxMs}ms (bound ${report.settle.boundMs}ms — a bound, not a target)`,
    `  total spent settling: ${report.settle.totalMs}ms`,
    ...(report.settle.settledStories === 0
      ? ['', '!! NOTHING SETTLED — every number below is meaningless.']
      : []),
  ]

  // Which capture sets the verdict rests on, stated rather than implied. One
  // invocation captures the baseline tree twice and the compare tree ONCE, so
  // this run cannot speak to the compare side's self-consistency — and saying
  // so beats reading as complete under a protocol that assumed pairs on both
  // sides.
  const provenance = [
    '=== capture provenance ===',
    `  baseline    ${report.baselineRef} (${report.baselineSha.slice(0, 9)}) captured ${report.captureSets.baselineCaptures}x · tree ${report.treeIdentity.baseline.digest.slice(0, 9)}`,
    `  compare     working tree (${report.treeIdentity.compare.head.slice(0, 9)}) captured ${report.captureSets.compareCaptures}x · tree ${report.treeIdentity.compare.digest.slice(0, 9)}`,
    `  captures in ${report.captureSets.baselineDir}`,
    '  The compare side was captured ONCE, so the self-inconsistency list below covers the baseline tree only. For an after-pair, run the gate again with --ref <after-sha>.',
  ]

  // The baseline health goes in the headline, not the detail. The false green
  // this guards against turned on a summary that said "no regressions" while
  // the report said every story failed at the baseline; a summary that cannot
  // express "the baseline was unusable" is part of that defect.
  const verdict = report.ok === true ? 'PASS' : 'FAIL'
  const lines = [
    ...liveness,
    '',
    ...provenance,
    '',
    `${verdict}  ${report.comparedStories} compared · ${report.baseline.passed}/${report.baseline.total} passed at baseline · ${report.changed.length} changed · ${report.added.length} added · ${report.removed.length} removed · ${report.uncovered.length} uncovered · ${report.preExisting.length} pre-existing · ${report.excluded.length} excluded · ${report.unsettled.length} never settled · ${report.nondeterministic.length} nondeterministic · ${report.selfInconsistent.length} self-inconsistent captures`,
    ...(report.baseline.passed === 0
      ? ['', 'Nothing passed at the baseline ref. That is an unusable baseline, not a clean run.']
      : []),
    ...(report.themeAxis.projects.length > 1
      ? [
          `theme axis  ${report.themeAxis.differing}/${report.themeAxis.comparable} comparable stories differ across ${report.themeAxis.projects.join(', ')}`,
        ]
      : []),
    ...(report.themeAxis.projects.length > 1 && report.themeAxis.differing === 0
      ? [
          '',
          'No story rendered differently across the theme projects. Either the theme global never reaches the styled element — in which case both projects captured the same palette and the coverage is imaginary — or this target ships one scheme and should pass --single-scheme.',
        ]
      : []),
    ...(report.uncovered.length > 0
      ? [
          '',
          `${report.uncovered.length} stories have no baseline image, so they were never compared.`,
        ]
      : []),
    ...(report.unsettled.length > 0
      ? [
          '',
          `${report.unsettled.length} stories never reached a quiet DOM within ${report.settle.boundMs}ms and were excluded from the visual comparison. Excluded BY OBSERVATION, not by declaration — nobody reviewed these. Either fix the story or declare parameters.storyGate.unstable so the decision is on the record.`,
        ]
      : []),
    ...(report.nondeterministic.length > 0
      ? [
          '',
          `${report.nondeterministic.length} stories rendered differently but were already known nondeterministic from the baseline probe, so their difference is not evidence either way. They are excluded from the changed list and named below; fix their nondeterminism and the gate can start speaking about them.`,
        ]
      : []),
    '',
    ...report.changed.map((change) => `  ${change.kind.padEnd(13)} ${change.story}`),
    ...report.added.map((story) => `  added         ${story}`),
    ...report.removed.map((story) => `  removed       ${story}`),
    ...report.uncovered.map((file) => `  uncovered     ${file}`),
    ...report.excluded.map((story) => `  excluded      ${story} (parameters.storyGate.unstable)`),
    ...report.unsettled.flatMap((record) => [
      `  never settled ${record.name} (${record.reason ?? 'unknown'}, gave up after ${record.elapsedMs}ms)`,
      `                shapes: ${record.shapes.join(' -> ')}`,
    ]),
    ...report.nondeterministic.map(
      (story) => `  nondeterministic ${story} (differs from itself at the baseline)`,
    ),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)

  return report.ok === true ? 0 : 1
}

/**
 * Run only when invoked directly — compared through `realpath`, which is the
 * load-bearing detail.
 *
 * Measured: a megarepo materialises `repos/effect-utils` as a SYMLINK into the
 * store, so `process.argv[1]` is the symlinked path while `import.meta.url` is
 * the resolved one. A plain comparison fails, the module loads, nothing runs,
 * and the process exits 0 WITH NO OUTPUT — a gate that silently does nothing
 * and reports success, which is the exact failure signature this gate exists to
 * eliminate. Every megarepo consumer reaches this file through such a symlink.
 */
const entryPath = process.argv[1]
if (entryPath !== undefined) {
  const invokedDirectly =
    import.meta.url === pathToFileURL(entryPath).href ||
    import.meta.url === pathToFileURL(realpathSync(entryPath)).href
  if (invokedDirectly === true) process.exitCode = await runStoryGateCli(process.argv.slice(2))
}
