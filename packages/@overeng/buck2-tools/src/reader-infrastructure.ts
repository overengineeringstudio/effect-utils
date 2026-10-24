/**
 * Linux process identities deliberately excluded from the legacy reader census.
 *
 * These exact comm AND argv shapes describe the observed per-user login/session
 * infrastructure, not programs selected by comm alone. This is an accidental
 * deletion safeguard, not protection against a same-user adversary (who can
 * rewrite both identities). Only the matched process is excluded: its children
 * remain independent census entries. Permission failures for every other process,
 * including all macOS processes, remain unknown reader evidence.
 */
export const isLinuxReaderInfrastructureIdentity = ({
  platform,
  comm,
  cmdline,
  uid,
  currentUid,
}: {
  readonly platform: string
  readonly comm: string
  readonly cmdline: readonly string[]
  readonly uid?: number | undefined
  readonly currentUid?: number | undefined
}): boolean => {
  if (platform !== 'linux' || currentUid === undefined) return false
  if (uid !== undefined && uid !== currentUid) return false

  // OpenSSH's setproctitle appears as one argv item (with possible NUL padding
  // removed by the proc reader). Do not admit command arguments after the title.
  if (comm === 'sshd-session' && cmdline.length === 1) {
    const title = cmdline[0] ?? ''
    return (
      title === 'sshd-session: schickling@notty' ||
      /^sshd-session: [A-Za-z0-9_][A-Za-z0-9_.-]*@pts\/[0-9]+(?:,pts\/[0-9]+)*$/.test(title)
    )
  }

  if (comm === '(sd-pam)') return cmdline.length === 1 && cmdline[0] === '(sd-pam)'

  return (
    comm === 'systemd' &&
    cmdline[0] === '/run/current-system/systemd/lib/systemd/systemd' &&
    cmdline[1] === '--user' &&
    (cmdline.length === 2 ||
      (cmdline.length === 3 && /^--deserialize=[0-9]+$/.test(cmdline[2] ?? '')))
  )
}
