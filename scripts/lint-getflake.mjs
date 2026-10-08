#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Local getFlake inputs must use the Git fetcher: path inputs copy ignored files too.
export const inspectGetFlake = (content) => {
  const source = content.replace(/^\s*#[^\n]*/gm, '').replace(/\\"/g, '"')
  const violations = []
  const calls = /\bbuiltins\.getFlake\s*\(*\s*(toString\b|builtins\.toString\b|builtins\.getEnv\s+"([^"]+)"|"(?:path:|\/|\.\/|\.\.\/|\$(?!NIX_FLAKE_REF\b|\{NIX_FLAKE_REF\b))[^"]*"|(?:\.\/|\.\.\/|\/)[^\s;)]+|(?!(?:builtins)\b)[a-zA-Z_][a-zA-Z0-9_]*)/g
  for (const match of source.matchAll(calls)) {
    if (match[2] === 'NIX_FLAKE_REF') continue
    violations.push('bare-path getFlake; use "git+file://" + toString repo')
  }
  // The shared test runner owns this environment contract. Reject path-valued
  // assignments as well as unsafe fallbacks in tests that accept an override.
  if (/\bNIX_FLAKE_REF\s*=\s*["']?(?:\/(?!\/)|\.\.?\/|\$(?:PWD|ROOT|repo_root)\b|\$\{NIX_FLAKE_REF:-\$(?:PWD|ROOT|repo_root)\b)/.test(source)) {
    violations.push('NIX_FLAKE_REF must be a git+file:// reference')
  }
  return violations
}

export const lintGetFlake = (paths) => {
  const violations = paths.flatMap((path) =>
    inspectGetFlake(readFileSync(path, 'utf8')).map((message) => `${path}: ${message}`),
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
