import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { CensusRequest, CensusResponse, CensusUnavailable } from './store-demand-census-wire.ts'

const request = {
  version: 1,
  bootId: '12345678-1234-1234-1234-123456789abc',
  nonce: 'a'.repeat(64),
  requestedAt: { monotonicNs: '123456789012345678901', wall: '2026-11-18T00:00:00Z' },
  requesterUid: 1000,
  authorizedRoots: ['/store'],
  namedLifetimes: [{ pid: 42, startTime: '123456789012345678901' }],
}
const decode = Schema.decodeUnknownSync(CensusRequest)

describe('demand census wire v1 rev 2', () => {
  it('preserves lossless decimal stamps and lifetimes', () => {
    const value = decode(request)
    expect(value.requestedAt.monotonicNs).toBe(request.requestedAt.monotonicNs)
    expect(value.namedLifetimes[0]?.startTime).toBe(request.namedLifetimes[0]?.startTime)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    'rejects non-count UID %s',
    (requesterUid) => {
      expect(() => decode({ ...request, requesterUid })).toThrow()
    },
  )

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects non-PID %s', (pid) => {
    expect(() => decode({ ...request, namedLifetimes: [{ pid, startTime: '1' }] })).toThrow()
  })

  it.each(['01', '-1', '1.0', '', '1e3'])('rejects noncanonical decimal %s', (startTime) => {
    expect(() => decode({ ...request, namedLifetimes: [{ pid: 42, startTime }] })).toThrow()
  })

  it.each(
    [
      [],
      ['/store', '/store'],
      ['/store/../other'],
      ['/store/'],
      ['relative'],
      ['/store\0x'],
      Array.from({ length: 33 }, (_, i) => `/s${i}`),
    ].map((authorizedRoots) => ({ authorizedRoots })),
  )('rejects invalid root sets $authorizedRoots', ({ authorizedRoots }) => {
    expect(() => decode({ ...request, authorizedRoots })).toThrow()
  })

  it('rejects empty, duplicate, conflicting and overflowing lifetime sets', () => {
    for (const namedLifetimes of [
      [],
      [
        { pid: 42, startTime: '1' },
        { pid: 42, startTime: '1' },
      ],
      [
        { pid: 42, startTime: '1' },
        { pid: 42, startTime: '2' },
      ],
      Array.from({ length: 257 }, (_, i) => ({ pid: i + 1, startTime: '1' })),
    ]) {
      expect(() => decode({ ...request, namedLifetimes })).toThrow()
    }
  })

  it('admits the pinned refusal reasons only', () => {
    const response = Schema.decodeUnknownSync(CensusResponse)
    expect(response({ _tag: 'Refused', version: 1, reason: 'busy' })._tag).toBe('Refused')
    expect(() => response({ _tag: 'Refused', version: 2, reason: 'busy' })).toThrow()
    expect(() => response({ _tag: 'Refused', version: 1, reason: 'unknown' })).toThrow()
  })

  it('bounds cwd/root detail arrays and nested snapshot JSON integers', () => {
    const response = Schema.decodeUnknownSync(CensusResponse)
    const snapshot = {
      schemaVersion: 'megarepo.workspace-activity.v2',
      producer: { name: 'mr-process', version: '1' },
      epoch: { host: 'localhost', snapshotId: request.bootId, storeIndex: 0 },
      capturedAt: request.requestedAt.wall,
      expiresAt: '2026-11-18T00:01:00Z',
      complete: true,
      errors: [],
      claims: [],
      processCoverage: 'all-uids',
      processRoots: ['/store'],
      processIdentities: [{ pid: 42, startTime: '1' }],
    }
    const evidence = {
      _tag: 'OwnUidDetails',
      cwd: ['/store'],
      root: [],
      fdTargets: [],
      mapTargets: [],
    }
    const complete = {
      _tag: 'Complete',
      version: 1,
      bootId: request.bootId,
      nonce: request.nonce,
      captureStartedAt: request.requestedAt,
      captureEndedAt: request.requestedAt,
      complete: true,
      snapshot,
      coverage: [{ _tag: 'Covered', lifetime: { pid: 42, startTime: '1' }, evidence }],
    }
    expect(response(complete)._tag).toBe('Complete')
    for (const field of ['cwd', 'root']) {
      expect(() =>
        response({
          ...complete,
          coverage: [
            {
              ...complete.coverage[0],
              evidence: { ...evidence, [field]: ['/store', '/store/child'] },
            },
          ],
        }),
      ).toThrow()
    }
    expect(() =>
      response({
        ...complete,
        snapshot: {
          ...snapshot,
          epoch: { ...snapshot.epoch, storeIndex: Number.MAX_SAFE_INTEGER + 1 },
        },
      }),
    ).toThrow()
    expect(() =>
      response({
        ...complete,
        snapshot: {
          ...snapshot,
          processIdentities: [{ pid: Number.MAX_SAFE_INTEGER + 1, startTime: '1' }],
        },
      }),
    ).toThrow()
    expect(
      response({
        ...complete,
        coverage: [
          {
            ...complete.coverage[0],
            evidence: { _tag: 'ForeignUidProjection', ownershipRoots: [] },
          },
        ],
      })._tag,
    ).toBe('Complete')
  })

  it('preserves structured refusal and unreadable lifetime failure evidence', () => {
    const decodeFailure = Schema.decodeUnknownSync(CensusUnavailable)
    const refusal = decodeFailure({
      _tag: 'CensusUnavailable',
      reason: 'admission',
      refusalReason: 'rate-limited',
    })
    expect(refusal.refusalReason).toBe('rate-limited')
    const unreadable = {
      lifetime: { pid: 42, startTime: '9007199254740993' },
      reason: 'permission-denied',
    }
    expect(
      decodeFailure({ _tag: 'CensusUnavailable', reason: 'admission', unreadable }).unreadable,
    ).toEqual(unreadable)
    expect(() =>
      decodeFailure({ _tag: 'CensusUnavailable', reason: 'admission', refusalReason: 'unknown' }),
    ).toThrow()
    expect(() =>
      decodeFailure({
        _tag: 'CensusUnavailable',
        reason: 'admission',
        unreadable: { ...unreadable, reason: 'unknown' },
      }),
    ).toThrow()
  })
})
