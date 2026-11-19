import { describe, it } from '@effect/vitest'
import { DateTime, Effect, Exit } from 'effect'
import { expect } from 'vitest'

import type { CensusRequest, CensusResponse, CensusStamp } from './store-demand-census-wire.ts'
import { validateDemandCensusResponse } from './store-demand-census.ts'
import { WORKSPACE_ACTIVITY_V2_SCHEMA } from './store-workspace-activity.ts'

const boot = '00000000-0000-0000-0000-000000000001'
const wall = DateTime.makeUnsafe('2026-11-18T12:00:00Z')
const lifetime = { pid: 42, startTime: '9007199254740993' }
const stamp = (monotonicNs: string): CensusStamp => ({ monotonicNs, wall })
const request: CensusRequest = {
  version: 1,
  bootId: boot,
  nonce: 'a'.repeat(64),
  requestedAt: stamp('1'),
  requesterUid: 1000,
  authorizedRoots: ['/store'],
  namedLifetimes: [lifetime],
}
const complete = (): Extract<CensusResponse, { _tag: 'Complete' }> => ({
  _tag: 'Complete',
  version: 1,
  bootId: boot,
  nonce: request.nonce,
  captureStartedAt: stamp('2'),
  captureEndedAt: stamp('3'),
  complete: true,
  coverage: [
    {
      _tag: 'Covered',
      lifetime,
      evidence: { _tag: 'OwnUidDetails', cwd: [], root: [], fdTargets: [], mapTargets: [] },
    },
  ],
  snapshot: {
    schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
    producer: { name: 'mr-process', version: '1' },
    epoch: { host: 'test', snapshotId: boot, storeIndex: 0 },
    capturedAt: wall,
    expiresAt: DateTime.makeUnsafe('2026-11-18T12:01:00Z'),
    complete: true,
    errors: [],
    processCoverage: 'all-uids',
    processRoots: ['/store'],
    processIdentities: [lifetime],
    claims: [],
  },
})
const validate = (response: CensusResponse) =>
  validateDemandCensusResponse({ request, response, receivedAt: stamp('4'), deadlineNs: 100n })

const adversarial: ReadonlyArray<
  readonly [string, (response: Extract<CensusResponse, { _tag: 'Complete' }>) => CensusResponse]
> = [
  ['refusal', () => ({ _tag: 'Refused', version: 1, reason: 'busy' })],
  ['nonce replay', (r) => ({ ...r, nonce: 'b'.repeat(64) })],
  ['boot mismatch', (r) => ({ ...r, bootId: '00000000-0000-0000-0000-000000000002' })],
  ['pre-request capture', (r) => ({ ...r, captureStartedAt: stamp('1') })],
  ['reversed capture', (r) => ({ ...r, captureStartedAt: stamp('4') })],
  ['future end', (r) => ({ ...r, captureEndedAt: stamp('5') })],
  ['capture duration', (r) => ({ ...r, captureEndedAt: stamp('10000000003') })],
  ['envelope incomplete', (r) => ({ ...r, complete: false })],
  ['snapshot incomplete', (r) => ({ ...r, snapshot: { ...r.snapshot, complete: false } })],
  ['collector errors', (r) => ({ ...r, snapshot: { ...r.snapshot, errors: ['gap'] } })],
  [
    'wrong producer',
    (r) => ({ ...r, snapshot: { ...r.snapshot, producer: { name: 'other', version: '1' } } }),
  ],
  [
    'wrong epoch',
    (r) => ({ ...r, snapshot: { ...r.snapshot, epoch: { ...r.snapshot.epoch, storeIndex: 1 } } }),
  ],
  [
    'missing identities',
    (r) => {
      const { processIdentities: _identities, ...snapshot } = r.snapshot
      return { ...r, snapshot }
    },
  ],
  [
    'duplicate identities',
    (r) => ({ ...r, snapshot: { ...r.snapshot, processIdentities: [lifetime, lifetime] } }),
  ],
  [
    'unsafe snapshot PID',
    (r) => ({
      ...r,
      snapshot: {
        ...r.snapshot,
        processIdentities: [{ ...lifetime, pid: Number.MAX_SAFE_INTEGER + 1 }],
      },
    }),
  ],
  [
    'noncanonical snapshot start tick',
    (r) => ({
      ...r,
      snapshot: { ...r.snapshot, processIdentities: [{ ...lifetime, startTime: '01' }] },
    }),
  ],
  [
    'reused PID identity',
    (r) => ({
      ...r,
      snapshot: { ...r.snapshot, processIdentities: [{ ...lifetime, startTime: '4' }] },
    }),
  ],
  ['root mismatch', (r) => ({ ...r, snapshot: { ...r.snapshot, processRoots: ['/other'] } })],
  [
    'duplicate roots',
    (r) => ({ ...r, snapshot: { ...r.snapshot, processRoots: ['/store', '/store'] } }),
  ],
  [
    'wrong wall end',
    (r) => ({
      ...r,
      captureEndedAt: { ...r.captureEndedAt, wall: DateTime.makeUnsafe('2026-11-18T12:00:01Z') },
    }),
  ],
  ['missing coverage', (r) => ({ ...r, coverage: [] })],
  ['duplicate coverage', (r) => ({ ...r, coverage: [...r.coverage, ...r.coverage] })],
  [
    'unreadable',
    (r) => ({ ...r, coverage: [{ _tag: 'Unreadable', lifetime, reason: 'permission-denied' }] }),
  ],
  ['false exit', (r) => ({ ...r, coverage: [{ _tag: 'Exited', lifetime }] })],
  [
    'foreign extra projection',
    (r) => ({
      ...r,
      coverage: [
        {
          _tag: 'Covered',
          lifetime,
          evidence: { _tag: 'ForeignUidProjection', ownershipRoots: ['/store/tree'] },
        },
      ],
    }),
  ],
  [
    'own unprojected reference',
    (r) => ({
      ...r,
      coverage: [
        {
          _tag: 'Covered',
          lifetime,
          evidence: {
            _tag: 'OwnUidDetails',
            cwd: ['/store/tree'],
            root: [],
            fdTargets: [],
            mapTargets: [],
          },
        },
      ],
    }),
  ],
  [
    'out-of-root path',
    (r) => ({
      ...r,
      coverage: [
        {
          _tag: 'Covered',
          lifetime,
          evidence: {
            _tag: 'OwnUidDetails',
            cwd: ['/etc'],
            root: [],
            fdTargets: [],
            mapTargets: [],
          },
        },
      ],
    }),
  ],
]

describe('demand census cross-field admission', () => {
  it.effect('admits empty own-UID detail after complete inspection', () =>
    Effect.gen(function* () {
      expect((yield* validate(complete()))._tag).toBe('Complete')
    }),
  )
  for (const [name, mutate] of adversarial) {
    it.effect(`vetoes ${name}`, () =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(validate(mutate(complete()))))).toBe(true)
      }),
    )
  }
  it.effect('admits empty foreign ownership without requiring raw paths', () =>
    Effect.gen(function* () {
      const response = complete()
      expect(
        (yield* validate({
          ...response,
          coverage: [
            {
              _tag: 'Covered',
              lifetime,
              evidence: { _tag: 'ForeignUidProjection', ownershipRoots: [] },
            },
          ],
        }))._tag,
      ).toBe('Complete')
    }),
  )
  it.effect('admits an exited old lifetime but does not cover its replacement', () =>
    Effect.gen(function* () {
      const response = complete()
      const result = yield* validate({
        ...response,
        coverage: [{ _tag: 'Exited', lifetime }],
        snapshot: { ...response.snapshot, processIdentities: [{ ...lifetime, startTime: '4' }] },
      })
      expect(result.snapshot.processIdentities).toEqual([{ ...lifetime, startTime: '4' }])
    }),
  )
  it.effect('requires foreign projection to match exactly attributed process claims', () =>
    Effect.gen(function* () {
      const response = complete()
      const snapshot = {
        ...response.snapshot,
        claims: [
          {
            workspace: '/store/tree',
            sources: ['process'] as const,
            active: true,
            agents: [],
            activeRuntimeIds: [],
            processes: [{ ...lifetime, executableClass: 'other' as const }],
          },
        ],
      }
      expect(
        (yield* validate({
          ...response,
          snapshot,
          coverage: [
            {
              _tag: 'Covered',
              lifetime,
              evidence: { _tag: 'ForeignUidProjection', ownershipRoots: ['/store/tree'] },
            },
          ],
        }))._tag,
      ).toBe('Complete')
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            validate({
              ...response,
              snapshot,
              coverage: [
                {
                  _tag: 'Covered',
                  lifetime,
                  evidence: { _tag: 'ForeignUidProjection', ownershipRoots: [] },
                },
              ],
            }),
          ),
        ),
      ).toBe(true)
    }),
  )
  it.effect('enforces capture, RPC and clipped run deadlines using integer nanoseconds', () =>
    Effect.gen(function* () {
      const response = { ...complete(), captureEndedAt: stamp('10000000002') }
      const options = {
        request,
        response,
        receivedAt: stamp('10000000003'),
        deadlineNs: 12000000001n,
      }
      expect((yield* validateDemandCensusResponse(options))._tag).toBe('Complete')
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            validateDemandCensusResponse({
              ...options,
              response: { ...response, captureEndedAt: stamp('10000000003') },
            }),
          ),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            validateDemandCensusResponse({
              ...options,
              deadlineNs: 10000000002n,
            }),
          ),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            validateDemandCensusResponse({
              ...options,
              receivedAt: stamp('12000000002'),
              deadlineNs: 13000000000n,
            }),
          ),
        ),
      ).toBe(true)
    }),
  )
  it.effect('retains structured refusal and unreadable lifetime evidence', () =>
    Effect.gen(function* () {
      const refusal = yield* validate({ _tag: 'Refused', version: 1, reason: 'rate-limited' }).pipe(
        Effect.flip,
      )
      expect(refusal.refusalReason).toBe('rate-limited')
      const response = complete()
      const unreadable = yield* validate({
        ...response,
        complete: false,
        snapshot: { ...response.snapshot, complete: false, errors: ['gap'] },
        coverage: [{ _tag: 'Unreadable', lifetime, reason: 'identity-unreadable' }],
      }).pipe(Effect.flip)
      expect(unreadable.unreadable).toEqual({ lifetime, reason: 'identity-unreadable' })
    }),
  )
})
