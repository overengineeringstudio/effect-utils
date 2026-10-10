import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const vanished = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')

const inaccessibleProcessEntry = (error: unknown): boolean =>
  vanished(error) === true ||
  (error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM'))

/**
 * Concrete kernel references and state-root pins protect only the snapshots they
 * name. Editors caching closed paths or hidden by process permissions must pin
 * their generation explicitly. An unavailable inventory backend fails closed.
 */
export const referencedEditorSnapshots = ({
  editorRoot,
  storeDir,
}: {
  readonly editorRoot: string
  readonly storeDir: string
}): ReadonlySet<string> | undefined => {
  const referenced = new Set<string>()
  const admit = (target: string): void => {
    if (target.startsWith('/') === false) return
    const path = target.endsWith(' (deleted)') === true ? target.slice(0, -10) : target
    const within = relative(storeDir, path)
    if (within === '..' || within.startsWith(`..${sep}`) === true || within.startsWith(sep)) return
    const snapshot = within.split(sep)[0]
    if (snapshot !== undefined && snapshot.length > 0) referenced.add(snapshot)
  }
  // Pins are ordinary symlinks anywhere under the state root outside the store.
  // Do not follow directory links: a pin may point into a payload or another root.
  const pins = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (path === storeDir) continue
      const status = lstatSync(path)
      if (status.isSymbolicLink() === true) {
        admit(resolve(directory, readlinkSync(path)))
        try {
          admit(realpathSync(path))
        } catch (error) {
          if (vanished(error) === false) throw error
        }
      } else if (status.isDirectory() === true) pins(path)
    }
  }
  pins(editorRoot)
  if (process.platform === 'linux') {
    try {
      for (const pid of readdirSync('/proc')) {
        if (/^[0-9]+$/.test(pid) === false) continue
        const directory = join('/proc', pid)
        try {
          // Publication is user-owned; other users' processes cannot participate
          // in this worktree's reader contract without an explicit readable pin.
          if (lstatSync(directory).uid !== process.getuid?.()) continue
          for (const entry of ['exe', 'cwd']) {
            try {
              admit(readlinkSync(join(directory, entry)))
            } catch (error) {
              if (inaccessibleProcessEntry(error) === false) throw error
            }
          }
          try {
            for (const fd of readdirSync(join(directory, 'fd'))) {
              try {
                admit(readlinkSync(join(directory, 'fd', fd)))
              } catch (error) {
                if (inaccessibleProcessEntry(error) === false) throw error
              }
            }
          } catch (error) {
            if (inaccessibleProcessEntry(error) === false) throw error
          }
          for (const entry of ['maps', 'cmdline']) {
            try {
              const content = readFileSync(join(directory, entry), 'utf8')
              if (entry === 'maps') {
                for (const line of content.split('\n')) {
                  const pathname = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1]
                  if (pathname !== undefined) admit(pathname)
                }
              } else {
                // A JS process may load its entry point and close that descriptor.
                for (const argument of content.split('\0'))
                  if (argument.startsWith(`${storeDir}/`) === true) admit(argument)
              }
            } catch (error) {
              if (inaccessibleProcessEntry(error) === false) throw error
            }
          }
        } catch (error) {
          if (inaccessibleProcessEntry(error) === false) return undefined
        }
      }
    } catch {
      return undefined
    }
    return referenced
  }
  if (process.platform === 'darwin') {
    // Native lsof is the macOS kernel-reader interface; no ambient PATH lookup.
    const result = spawnSync('/usr/sbin/lsof', ['-nP', '-Fn', '-u', String(process.getuid?.())], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return undefined
    for (const line of result.stdout.split('\n'))
      if (line.startsWith('n/') === true) admit(line.slice(1))
    return referenced
  }
  return undefined
}
