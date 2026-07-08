import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parseGeneratorPhase } from '../../core/phase.ts'
import { checkBootstrapClosure, formatViolationChain } from './bootstrap-closure.ts'

const usage = `Usage:
  genie-bootstrap-closure-check [--root <repo-root>]

Checks tracked // @genie-bootstrap .genie.ts files for runtime-only package imports.`

const parseArgs = ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): { readonly repoRoot: string; readonly help: boolean } => {
  let repoRoot = defaultRepoRoot
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--root requires a non-empty path')
      }
      repoRoot = path.resolve(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return { repoRoot, help }
}

const discoverGenieFiles = (repoRoot: string): readonly string[] =>
  execFileSync('git', ['-C', repoRoot, 'ls-files', '*.genie.ts'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((relativePath) => path.join(repoRoot, relativePath))

/**
 * Runs the standalone bootstrap import-closure checker CLI.
 */
export const bootstrapClosureCheckMain = ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): void => {
  try {
    const { repoRoot, help } = parseArgs({ argv, defaultRepoRoot })
    if (help === true) {
      console.log(usage)
      return
    }

    const allGenieFiles = discoverGenieFiles(repoRoot)
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
          'generator genuinely needs the runtime graph — remove its `// @genie-bootstrap` pragma ' +
          'so it runs post-install as a design-time generator (and ensure no install step depends on its output).',
      )
      process.exit(1)
    }

    console.log(
      `bootstrap-closure: OK — ${checkedSources.length} bootstrap-phase .genie.ts checked, no violations ` +
        `(${allGenieFiles.length - bootstrapFiles.length} design-time generator(s) out of scope by declaration)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`bootstrap-closure: ${message}`)
    process.exit(1)
  }
}
