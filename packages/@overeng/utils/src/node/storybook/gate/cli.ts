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

  // The baseline health goes in the headline, not the detail. The false green
  // this guards against turned on a summary that said "no regressions" while
  // the report said every story failed at the baseline; a summary that cannot
  // express "the baseline was unusable" is part of that defect.
  const verdict = report.ok === true ? 'PASS' : 'FAIL'
  const lines = [
    `${verdict}  ${report.comparedStories} compared · ${report.baseline.passed}/${report.baseline.total} passed at baseline · ${report.changed.length} changed · ${report.added.length} added · ${report.removed.length} removed · ${report.uncovered.length} uncovered · ${report.preExisting.length} pre-existing · ${report.excluded.length} excluded · ${report.selfInconsistent.length} self-inconsistent`,
    `baseline    ${report.baselineRef} (${report.baselineSha.slice(0, 9)})`,
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
    '',
    ...report.changed.map((change) => `  ${change.kind.padEnd(13)} ${change.story}`),
    ...report.added.map((story) => `  added         ${story}`),
    ...report.removed.map((story) => `  removed       ${story}`),
    ...report.uncovered.map((file) => `  uncovered     ${file}`),
    ...report.excluded.map((story) => `  excluded      ${story} (parameters.storyGate.unstable)`),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)

  return report.ok === true ? 0 : 1
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runStoryGateCli(process.argv.slice(2))
}
