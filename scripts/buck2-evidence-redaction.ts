import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { resolve } from 'node:path'

const contextPath = (evidencePath: string): string => `${evidencePath}.redaction-context.jsonl`
const invalidContext = (): never => {
  // Never attach filesystem/JSON errors: paths and malformed contents may contain credentials.
  throw new Error('Unsafe cache evidence redaction context')
}
const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
const validate = (fd: number): void => {
  const info = fstatSync(fd)
  if (
    info.isFile() === false ||
    (info.mode & 0o7777) !== 0o600 ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.()
  )
    invalidContext()
}

/** Append effective writer credentials privately in one O_APPEND write before native launch. */
export const recordCacheEvidenceRedaction = ({
  env,
  cwd = process.cwd(),
}: {
  env: Readonly<Record<string, string | undefined>>
  cwd?: string
}): void => {
  const evidencePath = env.CI_BUCK2_CACHE_EVIDENCE_PATH
  const values = [
    ...new Set(
      [env.BUCK2_CACHE_WRITE_BASIC_AUTH, env.BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH].filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    ),
  ]
  if (evidencePath === undefined || evidencePath.length === 0 || values.length === 0) return
  let fd: number | undefined
  try {
    fd = openSync(
      contextPath(resolve(cwd, evidencePath)),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    )
    validate(fd)
    const row = Buffer.from(`${JSON.stringify(values)}\n`)
    if (writeSync(fd, row) !== row.length) invalidContext()
  } catch {
    invalidContext()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Read only owner-private, regular, unlinked-to-other-paths context; absence is valid for readers. */
export const readCacheEvidenceRedaction = ({
  evidencePath,
}: {
  evidencePath: string
}): readonly string[] => {
  let fd: number | undefined
  try {
    try {
      fd = openSync(
        contextPath(evidencePath),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (error) {
      if (missing(error) === true) return []
      return invalidContext()
    }
    validate(fd)
    const raw = readFileSync(fd, 'utf8')
    if (raw.length === 0 || raw.endsWith('\n') === false) invalidContext()
    const values = new Set<string>()
    for (const line of raw.slice(0, -1).split('\n')) {
      const row: unknown = JSON.parse(line)
      if (Array.isArray(row) === false || row.length === 0) invalidContext()
      for (const value of row) {
        if (typeof value !== 'string' || value.length === 0) invalidContext()
        values.add(value)
      }
    }
    return [...values]
  } catch {
    return invalidContext()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Remove private context only after final artifact and summary writes have succeeded. */
export const removeCacheEvidenceRedaction = ({ evidencePath }: { evidencePath: string }): void => {
  let fd: number | undefined
  try {
    const path = contextPath(evidencePath)
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if (missing(error) === true) return
      invalidContext()
    }
    validate(fd)
    const opened = fstatSync(fd)
    const current = lstatSync(path)
    if (opened.dev !== current.dev || opened.ino !== current.ino) invalidContext()
    unlinkSync(path)
  } catch {
    invalidContext()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
