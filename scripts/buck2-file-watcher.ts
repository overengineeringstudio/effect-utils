import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const managedBegin = '# BEGIN effect-utils file watcher admission'
const managedEnd = '# END effect-utils file watcher admission'

/** Keep explicit local providers and the independently managed cache overlay intact. */
export const withoutManagedWatcherBlock = (current: string): string => {
  const output: string[] = []
  let inside = false
  let found = false
  for (const line of current.split(/\r?\n/u)) {
    if (line === managedBegin) {
      if (inside === true || found === true) throw new Error('duplicate managed file watcher block')
      inside = true
      found = true
    } else if (line === managedEnd) {
      if (inside === false) throw new Error('unmatched managed file watcher block end')
      inside = false
    } else if (inside === false) output.push(line)
  }
  if (inside === true) throw new Error('unterminated managed file watcher block')
  return output.join('\n').trimEnd()
}

/** The initial native daemon reads its watcher from this file, not CLI overrides. */
export const reconcileFileWatcher = ({
  repoRoot,
  provider,
}: {
  readonly repoRoot: string
  readonly provider?: 'watchman' | 'notify'
}): void => {
  const path = join(repoRoot, '.buckconfig.local')
  if (existsSync(path) === true && lstatSync(path).isSymbolicLink() === true)
    throw new Error('Buck file watcher: .buckconfig.local must not be a symbolic link')
  const current = existsSync(path) === true ? readFileSync(path, 'utf8') : ''
  const unmanaged = withoutManagedWatcherBlock(current)
  const block =
    provider === undefined
      ? ''
      : `${managedBegin}\n[buck2]\n  file_watcher = ${provider}\n${managedEnd}\n`
  const next =
    block === ''
      ? unmanaged === ''
        ? ''
        : `${unmanaged}\n`
      : unmanaged === ''
        ? block
        : `${unmanaged}\n\n${block}`
  if (next === current) return
  const candidate = `${path}.candidate-${randomUUID()}`
  try {
    writeFileSync(candidate, next, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, path)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/** Query the service; --version only checks a binary and misses unavailable Darwin sockets. */
export const probeWatchman = ({
  env,
  deadlineMs,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly deadlineMs: number
}): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  execFile(
    'watchman',
    [
      ...(process.platform === 'darwin' ? ['--no-spawn'] : []),
      '--no-local',
      ...(env['WATCHMAN_SOCK'] === undefined ? [] : [`--sockname=${env['WATCHMAN_SOCK']}`]),
      '--output-encoding=json',
      'version',
    ],
    { env, timeout: deadlineMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
    (error, stdout) => {
      if (error !== null) return resolve(false)
      try {
        const result: unknown = JSON.parse(stdout)
        resolve(
          typeof result === 'object' &&
            result !== null &&
            'version' in result &&
            typeof result.version === 'string' &&
            'error' in result === false,
        )
      } catch {
        resolve(false)
      }
    },
  )
  return promise
}
