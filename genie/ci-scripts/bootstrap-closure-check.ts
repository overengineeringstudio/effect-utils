#!/usr/bin/env bun
/**
 * Bootstrap-safe import-closure gate (issue #884) — BASELINE + RATCHET.
 *
 * A `.genie.ts` file (and every helper it transitively imports at RUNTIME) must be importable from a
 * fresh checkout BEFORE package-manager install state exists. A generator that transitively reaches a
 * runtime-only package — e.g. through a wide barrel that `export *`s a module importing `effect` — pulls
 * that package into the generator's bootstrap import closure and breaks `genie:run` on a fresh clone.
 *
 * This entry discovers every tracked `.genie.ts` (`git ls-files '*.genie.ts'`), runs the shared
 * {@link checkBootstrapClosure} walker, and compares the offending sources against a committed baseline of
 * accepted (pre-existing) violations. It fails ONLY on NEW violations (current \ baseline), so the gate can
 * be adopted over a repo that already has violations without a big-bang cleanup. It also warns on STALE
 * baseline entries (a baselined source that no longer violates) so the baseline can be ratcheted down.
 *
 * Usage:
 *   bun genie/ci-scripts/bootstrap-closure-check.ts                    # check (exit 1 on new violations)
 *   bun genie/ci-scripts/bootstrap-closure-check.ts --update-baseline  # regenerate the committed baseline
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  checkBootstrapClosure,
  formatViolationChain,
} from '../../packages/@overeng/genie/src/runtime/node/bootstrap-closure.ts'

const repoRoot = path.resolve(import.meta.dir, '../..')
const baselinePath = path.resolve(repoRoot, 'genie/bootstrap-closure-baseline.json')

/** Repo-relative POSIX-style path (portable across checkouts; safe to commit — this repo's own paths only). */
const toRepoRelative = (absolutePath: string): string => path.relative(repoRoot, absolutePath)

const discoverGenieFiles = (): readonly string[] =>
  execFileSync('git', ['-C', repoRoot, 'ls-files', '*.genie.ts'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((relativePath) => path.join(repoRoot, relativePath))

type Baseline = { readonly description?: string; readonly sources: readonly string[] }

const BASELINE_DESCRIPTION =
  'Accepted (pre-existing) bootstrap-closure violations — repo-relative `.genie.ts` sources that ' +
  'transitively reach a runtime-only package. Baseline + ratchet: a NEW violation fails the gate; a ' +
  'fixed source should be removed here. Regenerate with `bootstrap-closure:check --update-baseline`.'

const readBaselineSources = (): ReadonlySet<string> => {
  if (existsSync(baselinePath) === false) return new Set()
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline
  return new Set(parsed.sources ?? [])
}

const writeBaselineSources = (sources: readonly string[]): void => {
  const body: Baseline = { description: BASELINE_DESCRIPTION, sources: [...sources].toSorted() }
  writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

const main = (): void => {
  const updateBaseline = process.argv.includes('--update-baseline')
  const genieFiles = discoverGenieFiles()
  const { violations, checkedSources } = checkBootstrapClosure({ genieFiles })
  const currentSources = violations.map((violation) => toRepoRelative(violation.source)).toSorted()

  if (updateBaseline === true) {
    writeBaselineSources(currentSources)
    console.log(
      `bootstrap-closure: wrote baseline with ${currentSources.length} accepted violation(s) (${checkedSources.length} .genie.ts checked)`,
    )
    return
  }

  const baseline = readBaselineSources()
  const currentSet = new Set(currentSources)
  const newViolations = violations.filter(
    (violation) => baseline.has(toRepoRelative(violation.source)) === false,
  )
  const staleEntries = [...baseline].filter((source) => currentSet.has(source) === false).toSorted()

  if (staleEntries.length > 0) {
    console.warn(
      `⚠ bootstrap-closure: ${staleEntries.length} baselined source(s) no longer violate — remove them to ratchet (run with --update-baseline):`,
    )
    for (const source of staleEntries) console.warn(`    ${source}`)
  }

  if (newViolations.length > 0) {
    console.error(
      `✗ bootstrap-closure: ${newViolations.length} NEW bootstrap-closure violation(s) not in the baseline:\n`,
    )
    for (const violation of newViolations) {
      console.error(`  ${formatViolationChain({ violation, repoRoot })}\n`)
    }
    console.error(
      'A `.genie.ts` must be importable from a fresh checkout BEFORE install. Narrow the import (avoid wide barrels that reach runtime-only packages), or — if intentional — re-run this check with --update-baseline.',
    )
    process.exit(1)
  }

  console.log(
    `bootstrap-closure: OK — no new violations (${violations.length} baselined, ${checkedSources.length} .genie.ts checked)`,
  )
}

main()
