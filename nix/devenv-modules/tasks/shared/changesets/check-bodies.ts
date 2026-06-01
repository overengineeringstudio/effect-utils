#!/usr/bin/env bun
/**
 * Reject malformed Changesets: files that bump no packages AND carry no body.
 *
 * Catches `changeset add --empty` invocations whose `---\n---\n` placeholder was
 * never filled with a description, which would otherwise enter the
 * release-intent ledger as silent noise.
 *
 * A changeset is rejected when **both** hold:
 *   1. Its YAML frontmatter has no package bumps (truly empty).
 *   2. Its body (everything after the closing `---`) is empty.
 *
 * A changeset that bumps at least one package is always allowed (Changesets
 * itself drives the body for the release notes). An empty-bump changeset is
 * allowed iff it has a body explaining the intentional no-op.
 *
 * Usage:
 *   bun check-bodies.ts [--dir <changeset-dir>]
 *
 * Defaults to `.changeset` relative to the current working directory.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * Parse a changeset markdown file into its YAML frontmatter lines (between the
 * first two `---` fences) and body. Returns `undefined` when the file does not
 * have a valid frontmatter block.
 */
export const parseChangeset = (
  contents: string,
): { frontmatter: ReadonlyArray<string>; body: string } | undefined => {
  const lines = contents.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closingIndex === -1) return undefined
  return {
    frontmatter: lines
      .slice(1, closingIndex)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    body: lines
      .slice(closingIndex + 1)
      .join('\n')
      .trim(),
  }
}

const isChangesetMarkdown = (entry: string) => entry.endsWith('.md') && entry !== 'README.md'

/**
 * Validates every checked-in changeset in `dir`. Returns a list of human-readable
 * violation strings; an empty list means all changesets are well-formed.
 */
export const checkChangesetBodies = (dir: string): ReadonlyArray<string> => {
  const violations: string[] = []
  for (const entry of readdirSync(dir)) {
    if (isChangesetMarkdown(entry) === false) continue
    const file = path.join(dir, entry)
    if (statSync(file).isFile() === false) continue
    const contents = readFileSync(file, 'utf8')
    const parsed = parseChangeset(contents)
    if (parsed === undefined) {
      violations.push(`${file}: missing or malformed YAML frontmatter`)
      continue
    }
    const bumpsPackages = parsed.frontmatter.length > 0
    if (bumpsPackages === true) continue
    if (parsed.body.length === 0) {
      violations.push(
        `${file}: empty changeset with no body — add a one-line description of the change`,
      )
    }
  }
  return violations
}

const parseArgs = (argv: ReadonlyArray<string>): { dir: string } => {
  let dir = '.changeset'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error('--dir requires a path argument')
      dir = next
      i++
    } else if (arg !== undefined && arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { dir }
}

const main = () => {
  const { dir } = parseArgs(process.argv.slice(2))
  const violations = checkChangesetBodies(dir)
  if (violations.length > 0) {
    console.error(['Found malformed changesets:', ...violations].join('\n'))
    process.exit(1)
  }
  console.log('All changesets are well-formed.')
}

// Only run when invoked directly (allow importing parseChangeset for tests).
// `import.meta.main` works under Bun; `require.main === module` is the Node equivalent.
const isDirectInvocation =
  // @ts-expect-error - import.meta.main is Bun-specific
  (typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true) ||
  process.argv[1] === new URL(import.meta.url).pathname

if (isDirectInvocation) {
  main()
}
