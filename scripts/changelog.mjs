#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep the existing CHANGELOG.md section names and order.
export const sections = ['Added', 'Fixed', 'Changed', 'Removed']
const fragmentName = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(added|fixed|changed|removed)\.md$/

export const parseFragment = ({ name, content }) => {
  const match = fragmentName.exec(name)
  if (match === null) throw new Error(`Invalid fragment name: ${name}; use <slug>.<section>.md`)
  const body = content.trim()
  if (/^- \S/m.test(body.replace(/<!--[\s\S]*?-->/g, '')) === false)
    throw new Error(`Empty fragment: ${name}; write a Markdown bullet describing the change`)
  if (body.startsWith('- ') === false || /^\s*#/m.test(body) === true)
    throw new Error(`Invalid fragment: ${name}; use bullets and continuation text, not headings`)
  return { name, section: sections.find((section) => section.toLowerCase() === match[2]), body }
}

export const readFragments = (root) =>
  readdirSync(join(root, 'changelog.d'))
    .filter((name) => name !== 'README.md')
    .sort()
    .map((name) => {
      const path = join(root, 'changelog.d', name)
      if (lstatSync(path).isFile() === false)
        throw new Error(`Fragment must be a regular file: ${name}`)
      return parseFragment({ name, content: readFileSync(path, 'utf8') })
    })

/** Insert fragments without rewriting existing entries or released sections. */
export const assembleChangelog = ({ changelog, fragments }) => {
  const heading = /^## Unreleased\r?$/gm
  const matches = [...changelog.matchAll(heading)]
  if (matches.length !== 1)
    throw new Error('CHANGELOG.md must contain exactly one ## Unreleased heading')
  const start = matches[0].index + matches[0][0].length
  const nextRelease = /^## /gm
  nextRelease.lastIndex = start
  const end = nextRelease.exec(changelog)?.index ?? changelog.length
  let unreleased = changelog.slice(start, end)
  const existingSections = [...unreleased.matchAll(/^### (.+)\r?$/gm)].map((match) => match[1])
  if (new Set(existingSections).size !== existingSections.length)
    throw new Error('CHANGELOG.md has duplicate Unreleased sections')
  for (const section of existingSections)
    if (sections.includes(section) === false)
      throw new Error(`Unknown Unreleased section: ${section}`)
  for (const section of sections) {
    const entries = fragments
      .filter((fragment) => fragment.section === section)
      .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((fragment) => fragment.body)
      .join('\n')
    if (entries === '') continue
    const currentHeading = new RegExp(`^### ${section}\\r?$`, 'm').exec(unreleased)
    if (currentHeading !== null) {
      const position = currentHeading.index + currentHeading[0].length
      const blank = /^\r?\n(?:\r?\n)?/.exec(unreleased.slice(position))?.[0] ?? ''
      unreleased = `${unreleased.slice(0, position)}\n\n${entries}\n${unreleased.slice(position + blank.length)}`
    } else {
      const following = sections.slice(sections.indexOf(section) + 1)
      const position =
        [...unreleased.matchAll(/^### (.+)\r?$/gm)].find((match) => following.includes(match[1]))
          ?.index ?? unreleased.length
      const before = unreleased.slice(0, position)
      unreleased = `${before}${before.endsWith('\n\n') ? '' : '\n\n'}### ${section}\n\n${entries}\n\n${unreleased.slice(position)}`
    }
  }
  return changelog.slice(0, start) + unreleased + changelog.slice(end)
}

export const checkPrCoverage = ({ addedPaths, fragments, trailers }) => {
  const exemption = /^Changelog-None:[ \t]*(\S[^\r\n]*)$/im.exec(trailers)
  if (exemption !== null) return `Changelog exemption: ${exemption[1]}`
  if (fragments.some((fragment) => addedPaths.includes(`changelog.d/${fragment.name}`)) === false)
    throw new Error(
      'PR must add changelog.d/<slug>.<section>.md, or a Changelog-None: <reason> trailer to its latest commit',
    )
  return 'PR adds a changelog fragment'
}

export const run = ({ command, root = process.cwd(), env = process.env }) => {
  const fragments = readFragments(root)
  const changelogPath = join(root, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const assembled = assembleChangelog({ changelog, fragments })
  if (command === 'assemble') {
    // Write before removing inputs; a failed changelog write leaves all fragments intact.
    if (assembled !== changelog) writeFileSync(changelogPath, assembled)
    for (const fragment of fragments) unlinkSync(join(root, 'changelog.d', fragment.name))
    return `Assembled ${fragments.length} fragments into CHANGELOG.md; commit the changelog and fragment deletions together`
  }
  if (command !== 'check') throw new Error('Usage: bun scripts/changelog.mjs <check|assemble>')
  const git = (args, options = {}) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8', ...options })
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const { pull_request: pr } = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    const base = pr?.base?.sha
    const head = pr?.head?.sha
    if (
      [base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)) === false
    )
      throw new Error('PR event must provide base and head commit SHAs')
    // Checkout is shallow and may point at GitHub's synthetic merge, not the PR head.
    // Fetch only these histories so the diff is the PR's actual merge-base diff.
    git(['fetch', '--no-tags', '--depth=2147483647', 'origin', base, head])
    const addedPaths = git([
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--diff-filter=A',
      `${base}...${head}`,
      '--',
      'changelog.d',
    ]).split('\0')
    const commit = git(['show', '-s', '--format=%B', head])
    const trailers = git(['interpret-trailers', '--parse'], { input: commit })
    return checkPrCoverage({ addedPaths, fragments, trailers })
  }
  return `Validated ${fragments.length} changelog fragments (PR coverage runs on pull_request events)`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run({ command: process.argv[2] }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
