#!/usr/bin/env -S bun
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const MANAGED_BEGIN = '# effect-utils standalone cache posture: begin'
const MANAGED_END = '# effect-utils standalone cache posture: end'

const PUBLIC_CACHE_BLOCK = `${MANAGED_BEGIN}
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
${MANAGED_END}`

const TRUSTED_CACHE_BLOCK = `${MANAGED_BEGIN}
[archive_origin]
  url_prefix = http://dev3:41046/cas/
  tier = private
${MANAGED_END}`

const fail = (message: string): never => {
  throw new Error(`standalone Buck cache posture: ${message}`)
}

const withoutManagedBlock = (
  current: string,
): { readonly content: string; readonly found: boolean } => {
  const output: string[] = []
  let inside = false
  let found = false
  for (const line of current.split(/\r?\n/u)) {
    if (line === MANAGED_BEGIN) {
      if (inside === true || found === true) fail('duplicate managed block in .buckconfig.local')
      inside = true
      found = true
      continue
    }
    if (line === MANAGED_END) {
      if (inside === false) fail('unmatched managed block end in .buckconfig.local')
      inside = false
      continue
    }
    if (inside === false) output.push(line)
  }
  if (inside === true) fail('unterminated managed block in .buckconfig.local')
  return { content: output.join('\n').trimEnd(), found }
}

/** Derive the standalone checkout's local Buck config from the exact trust-tier opt-out. */
export const standaloneCachePostureConfig = ({
  current,
  env,
}: {
  readonly current: string
  readonly env: Readonly<Record<string, string | undefined>>
}): string | undefined => {
  const withoutManaged = withoutManagedBlock(current)
  const managed = env['BUCK2_NO_REMOTE_CACHE'] === '1' ? PUBLIC_CACHE_BLOCK : TRUSTED_CACHE_BLOCK
  const unmanaged = withoutManaged.content
  return unmanaged === '' ? `${managed}\n` : `${unmanaged}\n\n${managed}\n`
}

/** Atomically publish or remove only the managed cache posture block. */
export const reconcileStandaloneCachePosture = ({
  repoRoot,
  env,
}: {
  readonly repoRoot: string
  readonly env: Readonly<Record<string, string | undefined>>
}): void => {
  const output = resolve(repoRoot, '.buckconfig.local')
  const exists = existsSync(output)
  if (exists === true && lstatSync(output).isSymbolicLink() === true)
    fail('.buckconfig.local must not be a symbolic link')
  const current = exists === true ? readFileSync(output, 'utf8') : ''
  const next = standaloneCachePostureConfig({ current, env })
  if (next === undefined) {
    if (exists === true) rmSync(output, { force: true })
    return
  }
  if (next === current) return
  const candidate = `${output}.candidate-${randomUUID().replaceAll('-', '')}`
  try {
    writeFileSync(candidate, next, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, output)
  } finally {
    rmSync(candidate, { force: true })
  }
}

if (import.meta.main === true)
  try {
    const repoRoot = process.argv[2] ?? fail('expected repository root argument')
    reconcileStandaloneCachePosture({ repoRoot, env: process.env })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
