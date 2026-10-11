import { describe, expect, it } from 'bun:test'

import { type DaemonStatus, decideReap, decodeDaemonStatus } from './buck2-daemon-reaper.ts'

const hour = 60 * 60 * 1000
const threshold = 3 * hour
const now = Date.parse('2026-10-11T12:00:00Z')

const daemon = (overrides: Partial<DaemonStatus> = {}): DaemonStatus => ({
  daemonId: 'daemon-a',
  pid: 100,
  forkserverPid: 101,
  projectRoot: '/work/root',
  isolationDir: 'v2',
  startTimeMs: now - 10 * hour,
  activeCommandCount: 0,
  ...overrides,
})

describe('decideReap', () => {
  it('reports a daemon whose project root is gone instead of killing it', () => {
    expect(
      decideReap({
        observation: { daemon: daemon(), rootExists: false, lastLogWriteMs: undefined },
        nowMs: now,
        idleThresholdMs: threshold,
      })._tag,
    ).toBe('report-gone')
  })

  it('keeps a daemon with an active command however old its last log is', () => {
    expect(
      decideReap({
        observation: {
          daemon: daemon({ activeCommandCount: 1 }),
          rootExists: true,
          lastLogWriteMs: now - 9 * hour,
        },
        nowMs: now,
        idleThresholdMs: threshold,
      })._tag,
    ).toBe('keep-active')
  })

  it('keeps a daemon whose last command finished within the threshold', () => {
    expect(
      decideReap({
        observation: { daemon: daemon(), rootExists: true, lastLogWriteMs: now - 2 * hour },
        nowMs: now,
        idleThresholdMs: threshold,
      }),
    ).toEqual({ _tag: 'keep-recent', daemon: daemon(), idleForMs: 2 * hour })
  })

  it('kills a daemon idle for at least the threshold', () => {
    expect(
      decideReap({
        observation: { daemon: daemon(), rootExists: true, lastLogWriteMs: now - threshold },
        nowMs: now,
        idleThresholdMs: threshold,
      }),
    ).toEqual({ _tag: 'kill-idle', daemon: daemon(), idleForMs: threshold })
  })

  it('never counts idle time from before the daemon started', () => {
    const young = daemon({ startTimeMs: now - hour })
    expect(
      decideReap({
        observation: { daemon: young, rootExists: true, lastLogWriteMs: now - 9 * hour },
        nowMs: now,
        idleThresholdMs: threshold,
      }),
    ).toEqual({ _tag: 'keep-recent', daemon: young, idleForMs: hour })
  })

  it('falls back to the start time when the root has no event logs', () => {
    expect(
      decideReap({
        observation: { daemon: daemon(), rootExists: true, lastLogWriteMs: undefined },
        nowMs: now,
        idleThresholdMs: threshold,
      }),
    ).toEqual({ _tag: 'kill-idle', daemon: daemon(), idleForMs: 10 * hour })
  })
})

describe('decodeDaemonStatus', () => {
  const status = {
    active_commands: [{ trace_id: 't' }],
    daemon_constraints: { daemon_id: 'daemon-a' },
    forkserver_pid: 101,
    isolation_dir: 'v2',
    process_info: { pid: 100 },
    project_root: '/work/root',
    start_time: '2026-10-11T02:00:00Z',
  }

  it('decodes the pinned buck2 status fields', () => {
    expect(decodeDaemonStatus(status)).toEqual({
      daemonId: 'daemon-a',
      pid: 100,
      forkserverPid: 101,
      projectRoot: '/work/root',
      isolationDir: 'v2',
      startTimeMs: now - 10 * hour,
      activeCommandCount: 1,
    })
  })

  it('accepts a daemon without a forkserver', () => {
    expect(decodeDaemonStatus({ ...status, forkserver_pid: null }).forkserverPid).toBeUndefined()
  })

  it('rejects status without active_commands rather than treating it as idle', () => {
    const { active_commands: _, ...withoutActive } = status
    expect(() => decodeDaemonStatus(withoutActive)).toThrow('lacks daemon status fields')
  })

  it('rejects an invalid pid', () => {
    expect(() => decodeDaemonStatus({ ...status, process_info: { pid: 0 } })).toThrow(
      'process_info.pid',
    )
  })
})
