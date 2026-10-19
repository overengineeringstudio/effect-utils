import { expect, it } from 'bun:test'

import {
  gateCgroupRelation,
  gateDaemonStopDecision,
  gateScopeIdentity,
} from './buck2-entrypoint.ts'

const root = '/project/root'
const isolation = 'owned'
const idle = { project_root: root, isolation_dir: isolation, active_commands: [] }

it('permits native kill only for an idle daemon in the selected project and isolation', () => {
  expect(gateDaemonStopDecision({ status: idle, root, isolation })).toBe('stop')
})

it('retains a daemon while any other client is active, even when the gate started it', () => {
  expect(
    gateDaemonStopDecision({
      status: { ...idle, active_commands: [{ command_name: 'build' }] },
      root,
      isolation,
    }),
  ).toBe('keep-active')
})

it('fails closed for absent, malformed, foreign-root or foreign-isolation status', () => {
  for (const status of [
    undefined,
    null,
    {},
    [],
    'no buckd running',
    { ...idle, active_commands: undefined },
    { ...idle, project_root: '/other/root' },
    { ...idle, isolation_dir: 'other' },
  ]) {
    expect(gateDaemonStopDecision({ status, root, isolation })).toBe('keep-unrecognized')
  }
})

it('compares nearest gate scope ownership for parent, nested and sibling memberships', () => {
  const scope = '/user.slice/user-1000.slice/user@1000.service/app.slice/gate-slot-heavy-123.scope'
  for (const suffix of ['', '/worker', '/worker/actions', '/sibling']) {
    expect(gateScopeIdentity(`0::${scope}${suffix}\n`)).toBe(scope)
  }
  expect(gateScopeIdentity(`0::${scope}/nested/gate-slot-heavy-456.scope/actions`)).toBe(
    `${scope}/nested/gate-slot-heavy-456.scope`,
  )
  expect(gateScopeIdentity(`0::${scope.replace('123', '999')}`)).not.toBe(scope)
})

it('does not invent gate ownership for non-unified, missing or ungated memberships', () => {
  for (const membership of ['', '1:memory:/gate-slot-heavy-123.scope', '0::relative', '0::/']) {
    expect(gateScopeIdentity(membership)).toBeUndefined()
  }
})

it('reuses parent, nested and sibling cgroups but migrates determinably foreign owners', () => {
  const scope = '/user.slice/app.slice/gate-slot-heavy-123.scope'
  for (const caller of [scope, `${scope}/worker`, `${scope}/sibling`]) {
    for (const daemon of [scope, `${scope}/actions`, `${scope}/other/actions`]) {
      expect(gateCgroupRelation({ caller: `0::${caller}`, daemon: `0::${daemon}` })).toBe('same')
    }
    expect(
      gateCgroupRelation({
        caller: `0::${caller}`,
        daemon: '0::/user.slice/app.slice/session.scope',
      }),
    ).toBe('foreign')
    expect(
      gateCgroupRelation({ caller: `0::${caller}`, daemon: `0::${scope.replace('123', '999')}` }),
    ).toBe('foreign')
    expect(gateCgroupRelation({ caller: `0::${caller}`, daemon: '1:memory:/unknown' })).toBe(
      'unknown',
    )
  }
  expect(
    gateCgroupRelation({ caller: '0::/user.slice/session.scope', daemon: `0::${scope}` }),
  ).toBe('unknown')
})
