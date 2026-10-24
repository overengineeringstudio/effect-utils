import { describe, expect, it } from 'vitest'

import { isLinuxReaderInfrastructureIdentity } from './reader-infrastructure.ts'

const identity = (comm: string, cmdline: readonly string[]) => ({
  platform: 'linux',
  comm,
  cmdline,
  uid: 1000,
  currentUid: 1000,
})

describe('documented Linux reader infrastructure identities', () => {
  it.each([
    identity('sshd-session', ['sshd-session: schickling@notty']),
    identity('sshd-session', ['sshd-session: schickling@pts/39,pts/31,pts/29']),
    identity('sshd-session', ['sshd-session: schickling@pts/34']),
    identity('sshd-session', ['sshd-session: schickling@pts/26']),
    identity('sshd-session', ['sshd-session: other-user@pts/0']),
    identity('systemd', ['/run/current-system/systemd/lib/systemd/systemd', '--user']),
    identity('systemd', [
      '/run/current-system/systemd/lib/systemd/systemd',
      '--user',
      '--deserialize=21',
    ]),
    identity('(sd-pam)', ['(sd-pam)']),
  ])('admits the exact comm and argv pair: $comm $cmdline', (input) => {
    expect(isLinuxReaderInfrastructureIdentity(input)).toBe(true)
    expect(isLinuxReaderInfrastructureIdentity({ ...input, platform: 'darwin' })).toBe(false)
    expect(isLinuxReaderInfrastructureIdentity({ ...input, uid: 1001 })).toBe(false)
    expect(isLinuxReaderInfrastructureIdentity({ ...input, currentUid: undefined })).toBe(false)
    expect(isLinuxReaderInfrastructureIdentity({ ...input, comm: 'unrelated' })).toBe(false)
  })

  it.each([
    identity('sshd-session', ['arbitrary-reader']),
    identity('sshd-session', ['sshd-session: other-user@notty']),
    identity('sshd-session', ['sshd-session: schickling@pts/34', 'payload']),
    identity('sshd-session', ['sshd-session: schickling@pts/34,../payload']),
    identity('sshd-session', ['sshd-session: schickling@pts/34 (deleted)']),
    identity('systemd', ['systemd', '--user']),
    identity('systemd', ['/run/current-system/systemd/lib/systemd/systemd', '--system']),
    identity('systemd', ['/run/current-system/systemd/lib/systemd/systemd', '--user', '/payload']),
    identity('systemd', [
      '/run/current-system/systemd/lib/systemd/systemd',
      '--user',
      '--deserialize=21',
      'extra',
    ]),
    identity('(sd-pam)', ['(sd-pam)', '/payload']),
    identity('(sd-pam)', ['sd-pam']),
  ])('does not exempt a matching comm with another argv: $comm $cmdline', (input) => {
    expect(isLinuxReaderInfrastructureIdentity(input)).toBe(false)
  })
})
