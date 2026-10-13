import { lstatSync, readFileSync } from 'node:fs'
import { normalize } from 'node:path'

/** Syscall evidence: only ENOENT proves absence; permissions cannot prove isolation. */
export type PathEvidence =
  | { dev: number; ino: number; directory: boolean; symlink: boolean }
  | { errno: string }

const decodeMountField = (value: string | undefined) =>
  (value ?? '').replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )

/** Verify a boundary, not the provenance of its caller-controlled Nix declaration. */
export const verifyOuterFilesystem = ({
  top,
  passwd,
  mountinfo,
  inspect,
}: {
  top: string
  passwd: string
  mountinfo: string
  inspect: (path: string) => PathEvidence
}): string[] => {
  const failures: string[] = []
  const mounts = mountinfo
    .trim()
    .split('\n')
    .map((line) => {
      const fields = line.split(' ')
      return { root: decodeMountField(fields[3]), point: decodeMountField(fields[4]) }
    })
  const rootMounts = mounts.filter((mount) => mount.point === '/')
  if (rootMounts.length !== 1 || rootMounts[0]?.root === '/' || rootMounts[0]?.root === '') {
    failures.push('filesystem: / must be mounted from a pivoted or chrooted subtree')
  }

  const absentPaths = new Set(['/home', '/root', '/run/user', '/nix/var/nix'])
  for (const line of passwd.trim().split('\n')) {
    const fields = line.split(':')
    const uid = Number(fields[2])
    const home = fields[5] === undefined ? undefined : normalize(fields[5])
    if ((uid === 0 || (uid >= 1000 && uid < 65534)) && home !== undefined) {
      if (home !== top && home.startsWith(`${top}/`) === false) absentPaths.add(home)
    }
  }
  for (const path of absentPaths) {
    const evidence = inspect(path)
    if (!('errno' in evidence) || evidence.errno !== 'ENOENT') {
      failures.push(`filesystem: ${path} must be absent (ENOENT, not access denied)`)
    }
  }

  const tmp = inspect('/tmp')
  if ('errno' in tmp) {
    if (tmp.errno !== 'ENOENT') failures.push('filesystem: /tmp absence must be ENOENT')
  } else {
    const build = inspect(top)
    const root = inspect('/')
    const buildAlias = !('errno' in build) && tmp.dev === build.dev && tmp.ino === build.ino
    const privateRootDirectory =
      tmp.directory === true &&
      tmp.symlink === false &&
      !('errno' in root) &&
      tmp.dev === root.dev &&
      !mounts.some((mount) => mount.point === '/tmp')
    if (buildAlias === false && privateRootDirectory === false) {
      failures.push(
        'filesystem: /tmp must be absent, the build directory, or a plain directory on the root mount without a separate or bind mount',
      )
    }
  }
  return failures
}

const inspectPath = (path: string): PathEvidence => {
  try {
    const stat = lstatSync(path)
    return {
      dev: stat.dev,
      ino: stat.ino,
      directory: stat.isDirectory(),
      symlink: stat.isSymbolicLink(),
    }
  } catch (error) {
    return {
      errno:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN',
    }
  }
}

if (import.meta.main === true) {
  try {
    const failures = verifyOuterFilesystem({
      top: process.argv[2] ?? '',
      passwd: readFileSync('/etc/passwd', 'utf8'),
      mountinfo: readFileSync('/proc/self/mountinfo', 'utf8'),
      inspect: inspectPath,
    })
    for (const failure of failures) console.error(`Failed criterion: ${failure}`)
    if (failures.length !== 0) process.exitCode = 1
  } catch (error) {
    console.error('Failed criterion: filesystem: cannot read passwd or mount evidence', error)
    process.exitCode = 1
  }
}
