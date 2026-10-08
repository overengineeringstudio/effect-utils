#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Local getFlake inputs must use the Git fetcher: path inputs copy ignored files too.
const normalize = (content) => content.replace(/^\s*#[^\n]*/gm, '').replace(/\\"/g, '"')
const assignments = (source) =>
  [...source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*_FLAKE_REF)\s*=\s*["']?([^\s"';]+)/g)]
const isGitRef = (value) =>
  value.startsWith('git+file://') || /^\$\{[A-Za-z_][A-Za-z0-9_]*_FLAKE_REF:-git\+file:\/\//.test(value)

export const inspectGetFlake = (content, validFlakeRefs = new Set()) => {
  const source = normalize(content)
  const violations = []
  const refs = new Set(validFlakeRefs)
  for (const [, name, value] of assignments(source)) {
    if (isGitRef(value)) refs.add(name)
    else violations.push(`${name} must be a git+file:// reference`)
  }
  const calls = /\bbuiltins\.getFlake\s*\(*\s*(toString\b|builtins\.(?:toString|toPath)\b|builtins\.getEnv\s+"([^"]+)"|"(\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::-[^"]*)?\}))"|"(?:path:|\/|\.\/|\.\.\/)[^"]*"|(?:\.\/|\.\.\/|\/)[^\s;)]+|(?!(?:builtins)\b)[a-zA-Z_][a-zA-Z0-9_]*)/g
  for (const match of source.matchAll(calls)) {
    const envRef = match[2] ?? match[3]?.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    if (envRef !== undefined && refs.has(envRef)) continue
    violations.push('bare-path getFlake; use "git+file://" + toString repo')
  }
  return violations
}

export const lintGetFlake = (paths) => {
  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  // Environment reads are allowed only when the scanned runner/test sources
  // establish a Git-valued assignment contract; unknown names are not exempt.
  const validFlakeRefs = new Set()
  for (const { content } of files) {
    for (const [, name, value] of assignments(normalize(content))) {
      if (isGitRef(value)) validFlakeRefs.add(name)
    }
  }
  const violations = files.flatMap(({ path, content }) =>
    inspectGetFlake(content, validFlakeRefs).map((message) => `${path}: ${message}`),
  )
  for (const violation of violations) console.error(violation)
  return violations.length === 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let paths = process.argv.slice(2)
  if (paths.length === 0) {
    const result = spawnSync('git', ['ls-files', '-z', '--', '*.nix', '*.sh'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed')
    paths = result.stdout.split('\0').filter(Boolean)
  }
  if (lintGetFlake(paths) === false) process.exitCode = 1
  else console.log('getFlake lint: PASS (no bare-path inputs)')
}
