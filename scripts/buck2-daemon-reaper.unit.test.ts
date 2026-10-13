import { describe, expect, it } from 'bun:test'

import {
  type DaemonProcess,
  type DaemonStatus,
  decideReap,
  decodeDaemonStatus,
  parseDaemonProcess,
  type ReapDecision,
} from './buck2-daemon-reaper.ts'

const hour = 60 * 60 * 1000
const threshold = 3 * hour
const now = Date.parse('2026-10-11T12:00:00Z')

const daemon: DaemonProcess = {
  pid: 100,
  daemonId: 'daemon-a',
  isolationDir: 'v2',
  projectRoot: '/work/root',
  rootGone: false,
  forkserverPid: 101,
}

const status = (overrides: Partial<DaemonStatus> = {}): DaemonStatus => ({
  daemonId: 'daemon-a',
  pid: 100,
  projectRoot: '/work/root',
  startTimeMs: now - 10 * hour,
  activeCommandCount: 0,
  ...overrides,
})

const decide = (
  overrides: Partial<DaemonStatus>,
  lastLogWriteMs: number | undefined,
): ReapDecision =>
  decideReap({
    observation: { _tag: 'observed', daemon, status: status(overrides), lastLogWriteMs },
    nowMs: now,
    idleThresholdMs: threshold,
  })

describe('decideReap', () => {
  it('reports a daemon whose project root is gone instead of killing it', () => {
    expect(
      decideReap({ observation: { _tag: 'gone', daemon }, nowMs: now, idleThresholdMs: threshold }),
    ).toEqual({ _tag: 'report-gone', daemon })
  })

  it('keeps a daemon whose status cannot be read', () => {
    expect(
      decideReap({
        observation: { _tag: 'unreachable', daemon, reason: 'status-exit-null' },
        nowMs: now,
        idleThresholdMs: threshold,
      }),
    ).toEqual({ _tag: 'keep-unreachable', daemon, reason: 'status-exit-null' })
  })

  it('keeps a daemon with an active command however old its last log is', () => {
    expect(decide({ activeCommandCount: 1 }, now - 9 * hour)._tag).toBe('keep-active')
  })

  it('keeps a daemon whose last command finished within the threshold', () => {
    expect(decide({}, now - 2 * hour)).toEqual({
      _tag: 'keep-recent',
      daemon,
      idleForMs: 2 * hour,
    })
  })

  it('kills a daemon idle for at least the threshold', () => {
    expect(decide({}, now - threshold)).toEqual({ _tag: 'kill-idle', daemon, idleForMs: threshold })
  })

  it('never counts idle time from before the daemon started', () => {
    expect(decide({ startTimeMs: now - hour }, now - 9 * hour)).toEqual({
      _tag: 'keep-recent',
      daemon,
      idleForMs: hour,
    })
  })

  it('falls back to the start time when the root has no event logs', () => {
    expect(decide({}, undefined)).toEqual({ _tag: 'kill-idle', daemon, idleForMs: 10 * hour })
  })
})

describe('parseDaemonProcess', () => {
  const argv = ['buck2d[root]', '--isolation-dir', 'v2', 'daemon', '--daemon-id', 'daemon-a', '{}']

  it('derives root and isolation from argv and the buck-out cwd', () => {
    expect(parseDaemonProcess({ pid: 100, argv, cwd: '/work/root/buck-out/v2' })).toEqual({
      pid: 100,
      daemonId: 'daemon-a',
      isolationDir: 'v2',
      projectRoot: '/work/root',
      cwdDeleted: false,
    })
  })

  it('recognizes an unlinked cwd', () => {
    expect(
      parseDaemonProcess({ pid: 100, argv, cwd: '/work/root/buck-out/v2 (deleted)' }).cwdDeleted,
    ).toBe(true)
  })

  it('uses the cwd itself as the candidate root while the daemon works from its root', () => {
    expect(parseDaemonProcess({ pid: 100, argv, cwd: '/work/root' }).projectRoot).toBe('/work/root')
  })
})

describe('decodeDaemonStatus', () => {
  const raw = {
    active_commands: [{ trace_id: 't' }],
    daemon_constraints: { daemon_id: 'daemon-a' },
    process_info: { pid: 100 },
    project_root: '/work/root',
    start_time: '2026-10-11T02:00:00Z',
  }

  it('decodes the pinned buck2 status fields', () => {
    expect(decodeDaemonStatus(raw)).toEqual(status({ activeCommandCount: 1 }))
  })

  it('rejects status without active_commands rather than treating it as idle', () => {
    const { active_commands: _, ...withoutActive } = raw
    expect(() => decodeDaemonStatus(withoutActive)).toThrow('lacks daemon status fields')
  })

  it('rejects an invalid pid', () => {
    expect(() => decodeDaemonStatus({ ...raw, process_info: { pid: 0 } })).toThrow(
      'process_info.pid',
    )
  })
})
