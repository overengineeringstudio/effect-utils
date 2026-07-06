#!/usr/bin/env bun
/**
 * Bootstrap-safe import-closure gate (issue #884) — SCOPED TO BOOTSTRAP-PHASE GENERATORS,
 * ZERO-TOLERANCE (decision 0004).
 *
 * A `bootstrap`-phase `.genie.ts` (and every helper it transitively imports at RUNTIME) must be
 * importable from a fresh checkout BEFORE package-manager install state exists — it runs in
 * `genie:prepare`, before install, so it must not reach a runtime-only package (e.g. through a wide
 * barrel that `export *`s a module importing `effect`). `design-time` generators are exempt by
 * declaration: they run after install (post-install `genie:run`) and may use the runtime graph.
 *
 * This entry discovers every tracked `.genie.ts` (`git ls-files '*.genie.ts'`), keeps only those
 * whose static `// @genie-phase bootstrap` pragma marks them bootstrap-phase, runs the shared
 * {@link checkBootstrapClosure} walker over that set, and FAILS on ANY violation. There is no
 * baseline and no allowlist: the residual weaver generators are `design-time` by declaration, so
 * they are structurally out of scope rather than an accepted exception.
 *
 * This gate is fast local feedback for the ordering contract (R30/R32); install ordering
 * (`pnpm:install` after the bootstrap-phase genie run) is the ultimate arbiter (R32).
 *
 * Usage:
 *   bun genie/ci-scripts/bootstrap-closure-check.ts   # exit 1 on any bootstrap-phase violation
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parseGeneratorPhase } from '../../packages/@overeng/genie/src/core/phase.ts'
import {
  checkBootstrapClosure,
  formatViolationChain,
} from '../../packages/@overeng/genie/src/runtime/node/bootstrap-closure.ts'

const repoRoot = path.resolve(import.meta.dir, '../..')

const discoverGenieFiles = (): readonly string[] =>
  execFileSync('git', ['-C', repoRoot, 'ls-files', '*.genie.ts'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((relativePath) => path.join(repoRoot, relativePath))

const main = (): void => {
  const allGenieFiles = discoverGenieFiles()
  const bootstrapFiles = allGenieFiles.filter(
    (file) => parseGeneratorPhase(readFileSync(file, 'utf8')) === 'bootstrap',
  )

  const { violations, checkedSources } = checkBootstrapClosure({ genieFiles: bootstrapFiles })

  if (violations.length > 0) {
    console.error(
      `✗ bootstrap-closure: ${violations.length} bootstrap-phase generator(s) reach a runtime-only package:\n`,
    )
    for (const violation of violations) {
      console.error(`  ${formatViolationChain({ violation, repoRoot })}\n`)
    }
    console.error(
      'A `bootstrap`-phase `.genie.ts` must be importable from a fresh checkout BEFORE install. ' +
        'Narrow the import (avoid wide barrels that reach runtime-only packages), or — if the ' +
        'generator genuinely needs the runtime graph — remove its `// @genie-phase bootstrap` pragma ' +
        'so it runs post-install as a design-time generator (and ensure no install step depends on its output).',
    )
    process.exit(1)
  }

  console.log(
    `bootstrap-closure: OK — ${checkedSources.length} bootstrap-phase .genie.ts checked, no violations ` +
      `(${allGenieFiles.length - bootstrapFiles.length} design-time generator(s) out of scope by declaration)`,
  )
}

main()
