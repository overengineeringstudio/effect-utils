import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const vanished = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')

const inaccessibleProcessEntry = (error: unknown): boolean =>
  vanished(error) === true ||
  (error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM'))

/** Durable managed-reader contract, separate from advisory shell symlinks. */
export const editorViewPinSchema = 'effect-utils/editor-view-pin/v1' as const

export type EditorViewPinRecord = {
  readonly schema: typeof editorViewPinSchema
  readonly name: string
  readonly snapshot: string
}

/** Pin names are single portable path components shared by an editor state root. */
export const requireEditorViewPinName = (name: string): string => {
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) === false)
    throw new Error(`editor view: pin name must be a portable identifier without dots: ${name}`)
  return name
}

/** Decode a named registration; callers hold the content-store flock. */
export const readEditorViewPinRecord = ({
  path,
  name,
}: {
  readonly path: string
  readonly name: string
}): EditorViewPinRecord => {
  requireEditorViewPinName(name)
  if (lstatSync(path).isFile() === false)
    throw new Error(`editor view: managed pin must be a regular file: ${path}`)
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) === true ||
    Object.keys(value).toSorted().join(',') !== 'name,schema,snapshot' ||
    'schema' in value === false ||
    value.schema !== editorViewPinSchema ||
    'name' in value === false ||
    value.name !== name ||
    'snapshot' in value === false ||
    typeof value.snapshot !== 'string' ||
    /^\.store\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{64}$/.test(value.snapshot) === false
  )
    throw new Error(`editor view: managed pin does not conform to ${editorViewPinSchema}: ${path}`)
  return { schema: editorViewPinSchema, name, snapshot: value.snapshot }
}

/** Inspect only managed JSON registrations while holding the content-store flock. */
export const managedEditorViewSnapshots = (editorRoot: string): ReadonlySet<string> => {
  const referenced = new Set<string>()
  const directory = join(editorRoot, '.pins')
  try {
    const status = lstatSync(directory)
    if (status.isDirectory() === false)
      throw new Error(`editor view: managed pins must be a real directory: ${directory}`)
  } catch (error) {
    if (vanished(error) === true) return referenced
    throw error
  }
  for (const file of readdirSync(directory)) {
    if (file.endsWith('.json') === false) continue
    const record = readEditorViewPinRecord({
      path: join(directory, file),
      name: file.slice(0, -'.json'.length),
    })
    referenced.add(record.snapshot.slice('.store/'.length))
  }
  return referenced
}

/**
 * This census is advisory: kernel references and shell symlinks can appear after
 * inspection, and permissions can hide readers. Guaranteed retention requires a
 * managed pin admitted under the content-store flock before using a generation.
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
    if (
      within === '..' ||
      within.startsWith(`..${sep}`) === true ||
      within.startsWith(sep) === true
    )
      return
    const snapshot = within.split(sep)[0]
    if (snapshot !== undefined && snapshot.length > 0) referenced.add(snapshot)
  }
  // Shell-created symlinks are advisory observations, not managed registrations.
  // Do not follow directory links: a link may point into a payload or another root.
  const pins = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (path === storeDir) continue
      try {
        const status = lstatSync(path)
        if (status.isSymbolicLink() === true) {
          admit(resolve(directory, readlinkSync(path)))
          try {
            admit(realpathSync(path))
          } catch (error) {
            if (vanished(error) === false) throw error
          }
        } else if (status.isDirectory() === true) pins(path)
      } catch (error) {
        // Managed registrations are atomically renamed while this advisory walk
        // runs outside the flock. A vanished observation is not a failed census.
        if (vanished(error) === false) throw error
      }
    }
  }
  pins(editorRoot)
  if (process.platform === 'linux') {
    try {
      for (const pid of readdirSync('/proc')) {
        if (/^[0-9]+$/.test(pid) === false) continue
        const directory = join('/proc', pid)
        try {
          // Publication is user-owned; only same-user process references are
          // advisory evidence. Managed pins do not depend on process visibility.
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
