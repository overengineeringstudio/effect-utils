import assert from 'node:assert/strict'
import { test } from 'node:test'
import { passingReceipt } from './check-quick-receipt.mjs'

const head = 'a'.repeat(40)
const receipt = {
  schema: 'gate-slot.receipt/v1', class: 'gate', exit: 0, exact: true,
  cleanStart: true, cleanEnd: true, headStart: head, headEnd: head,
  treeStart: 'b'.repeat(40), route: { execution: 'local' }, reroutedFrom: null,
  cmd: ['devenv', 'tasks', 'run', 'check:quick', '--no-tui', '--show-output'],
  failedTasks: [], notRunTasks: 0,
  startedAt: '2026-11-19T10:02:16Z', endedAt: '2026-11-19T10:19:39Z',
}

test('accepts a passing exact-head local canonical gate', () => {
  assert.equal(passingReceipt(receipt, head), true)
})

for (const [field, value] of Object.entries({
  schema: 'other', class: 'heavy', exit: 1, exact: false,
  cleanStart: 'unknown', cleanEnd: false, headStart: 'c'.repeat(40),
  headEnd: 'c'.repeat(40), treeStart: '', route: { execution: 'remote' },
  reroutedFrom: 'gate', cmd: ['devenv', 'tasks', 'run', 'check:small-diff'],
  failedTasks: ['lint'], notRunTasks: 1, startedAt: 'invalid', endedAt: '2020-01-01',
})) {
  test(`rejects invalid ${field}`, () => {
    assert.equal(passingReceipt({ ...receipt, [field]: value }, head), false)
  })
}

test('unknown task trace is not success evidence', () => {
  assert.equal(passingReceipt({ ...receipt, failedTasks: null, notRunTasks: null }, head), false)
})

test('missing local execution provenance is rejected', () => {
  assert.equal(passingReceipt({ ...receipt, route: undefined }, head), false)
})
