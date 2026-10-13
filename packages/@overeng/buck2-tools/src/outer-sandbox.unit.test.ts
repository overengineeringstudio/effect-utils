import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { type PathEvidence, verifyOuterFilesystem } from './outer-sandbox.ts'

/** Raw `lstat` record emitted by the `buck2-outer-sandbox-probe/v1` Nix derivation. */
type ProbeStat =
  | { errno: 0; dev: number; ino: number; type: string }
  | { errno: number; errno_name: string }

type ProbeEvidence = {
  schema: string
  environment: { NIX_BUILD_TOP: string }
  mountinfo: string
  passwd: { name: string; uid: number; home: string }[]
  paths: Record<string, { lstat: ProbeStat }>
}

/** Actual dev4 probe output (EVIDENCE_BEGIN/END block, build-log prefixes stripped). */
const actual: ProbeEvidence = JSON.parse(
  readFileSync(new URL('./fixtures/outer-sandbox-dev4-evidence.json', import.meta.url), 'utf8'),
)

const top = actual.environment.NIX_BUILD_TOP

const passwdLine = ({ name, uid, home }: { name: string; uid: number; home: string }) =>
  `${name}:x:${uid}:100:${name}:${home}:/noshell`

const actualPasswd = actual.passwd.map(passwdLine).join('\n')

/** Inspects only recorded paths so an unrecorded lookup fails loudly instead of passing. */
const inspectWith =
  (overrides: Record<string, PathEvidence> = {}) =>
  (path: string): PathEvidence => {
    const override = overrides[path]
    if (override !== undefined) return override
    const stat = actual.paths[path]?.lstat
    if (stat === undefined) throw new Error(`fixture has no evidence for ${path}`)
    return 'errno_name' in stat
      ? { errno: stat.errno_name }
      : {
          dev: stat.dev,
          ino: stat.ino,
          directory: stat.type === 'directory',
          symlink: stat.type === 'symlink',
        }
  }

const verify = ({
  passwd = actualPasswd,
  mountinfo = actual.mountinfo,
  overrides,
}: {
  passwd?: string
  mountinfo?: string
  overrides?: Record<string, PathEvidence>
} = {}) => verifyOuterFilesystem({ top, passwd, mountinfo, inspect: inspectWith(overrides) })

const recorded = (path: string) => inspectWith()(path)
const rootDev = (() => {
  const root = recorded('/')
  return 'errno' in root ? Number.NaN : root.dev
})()

const enoent: PathEvidence = { errno: 'ENOENT' }
const existingDirectory: PathEvidence = {
  dev: rootDev,
  ino: 9_000_001,
  directory: true,
  symlink: false,
}

describe('outer Nix sandbox filesystem boundary', () => {
  it('records the actual dev4 probe evidence', () => {
    expect(actual.schema).toBe('buck2-outer-sandbox-probe/v1')
    expect(top).toBe('/build')
    expect(actual.mountinfo.split('\n')[0]).toContain('.drv.chroot/root / ')
  })

  it('accepts the actual dev4 snapshot', () => {
    expect(verify()).toEqual([])
  })

  it('rejects a root mount that is the host root (network namespace only)', () => {
    const [first = '', ...rest] = actual.mountinfo.split('\n')
    const fields = first.split(' ')
    fields[3] = '/'
    const hostRoot = [fields.join(' '), ...rest].join('\n')

    expect(verify({ mountinfo: hostRoot })).toEqual([
      'filesystem: / must be mounted from a pivoted or chrooted subtree',
    ])
  })

  it('rejects a separately mounted /tmp', () => {
    const mountinfo = `${actual.mountinfo.trimEnd()}\n4242 1938 0:99 / /tmp rw,nosuid,nodev,relatime - tmpfs none rw`
    expect(verify({ mountinfo })).toEqual([
      expect.stringMatching(/^filesystem: \/tmp must be absent/),
    ])
  })

  it('rejects the host /tmp bound into the sandbox on the root device', () => {
    const mountinfo = `${actual.mountinfo.trimEnd()}\n4242 1938 8:2 /tmp /tmp rw,nosuid,nodev,relatime - ext4 /dev/sda2 rw`
    expect(verify({ mountinfo })).toEqual([
      expect.stringMatching(/^filesystem: \/tmp must be absent/),
    ])
  })

  it('rejects a /tmp directory on another device than the root mount', () => {
    expect(verify({ overrides: { '/tmp': { ...existingDirectory, dev: rootDev + 1 } } })).toEqual([
      expect.stringMatching(/^filesystem: \/tmp must be absent/),
    ])
  })

  it('rejects a symlinked /tmp', () => {
    expect(
      verify({
        overrides: { '/tmp': { dev: rootDev, ino: 9_000_002, directory: false, symlink: true } },
      }),
    ).toEqual([expect.stringMatching(/^filesystem: \/tmp must be absent/)])
  })

  it('accepts an absent /tmp', () => {
    expect(verify({ overrides: { '/tmp': enoent } })).toEqual([])
  })

  it('rejects host /tmp bound at both the build directory and /tmp with equal device/inode', () => {
    const mountinfo = `${actual.mountinfo.trimEnd()}\n4242 1938 8:2 /tmp /build rw,nosuid,nodev,relatime - ext4 /dev/sda2 rw\n4243 1938 8:2 /tmp /tmp rw,nosuid,nodev,relatime - ext4 /dev/sda2 rw`
    expect(verify({ mountinfo, overrides: { '/tmp': recorded(top) } })).toEqual([
      expect.stringMatching(/^filesystem: \/tmp must be absent/),
    ])
  })

  it('rejects /tmp access denied instead of absent', () => {
    expect(verify({ overrides: { '/tmp': { errno: 'EACCES' } } })).toEqual([
      'filesystem: /tmp absence must be ENOENT',
    ])
  })

  it.each(['/home', '/root', '/run/user', '/nix/var/nix'])('rejects a visible %s', (path) => {
    expect(verify({ overrides: { [path]: existingDirectory } })).toEqual([
      `filesystem: ${path} must be absent (ENOENT, not access denied)`,
    ])
  })

  it.each(['/home', '/root', '/run/user', '/nix/var/nix'])(
    'rejects %s denied with EACCES instead of ENOENT',
    (path) => {
      expect(verify({ overrides: { [path]: { errno: 'EACCES' } } })).toEqual([
        `filesystem: ${path} must be absent (ENOENT, not access denied)`,
      ])
    },
  )

  it('rejects visible real passwd homes outside the build directory', () => {
    const passwd = [
      actualPasswd,
      passwdLine({ name: 'alice', uid: 1001, home: '/srv/alice' }),
      passwdLine({ name: 'admin', uid: 0, home: '/var/admin' }),
    ].join('\n')
    expect(
      verify({
        passwd,
        overrides: { '/srv/alice': existingDirectory, '/var/admin': { errno: 'EACCES' } },
      }),
    ).toEqual([
      'filesystem: /srv/alice must be absent (ENOENT, not access denied)',
      'filesystem: /var/admin must be absent (ENOENT, not access denied)',
    ])
  })

  it('accepts absent real passwd homes outside the build directory', () => {
    const passwd = `${actualPasswd}\n${passwdLine({ name: 'alice', uid: 1001, home: '/srv/alice' })}`
    expect(verify({ passwd, overrides: { '/srv/alice': enoent } })).toEqual([])
  })

  it('does not exempt a sibling home that only shares the build directory prefix', () => {
    const passwd = `${actualPasswd}\n${passwdLine({ name: 'alice', uid: 1001, home: `${top}-alice` })}`
    expect(verify({ passwd, overrides: { [`${top}-alice`]: existingDirectory } })).toEqual([
      `filesystem: ${top}-alice must be absent (ENOENT, not access denied)`,
    ])
  })

  it('exempts builder passwd homes at or below the build directory', () => {
    expect(actual.passwd.filter((entry) => entry.uid !== 65534).map((entry) => entry.home)).toEqual(
      [top, top],
    )
    const passwd = `${actualPasswd}\n${passwdLine({ name: 'builder', uid: 1001, home: `${top}/home` })}`
    expect(verify({ passwd })).toEqual([])
  })

  it('ignores nobody and system accounts even when their home is visible', () => {
    expect(actual.passwd).toContainEqual({ name: 'nobody', uid: 65534, home: '/' })
    const passwd = [
      actualPasswd,
      passwdLine({ name: 'nobody2', uid: 65534, home: '/var/empty' }),
      passwdLine({ name: 'daemon', uid: 999, home: '/var/lib/daemon' }),
    ].join('\n')
    expect(verify({ passwd })).toEqual([])
  })
})
