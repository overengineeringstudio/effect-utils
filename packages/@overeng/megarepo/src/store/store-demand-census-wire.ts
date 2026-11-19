import { posix } from 'node:path'

import { Schema } from 'effect'

import { ActivityManifest } from './store-workspace-activity.ts'

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Pid = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
const BootId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
)
const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const AbsolutePath = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      posix.isAbsolute(path) &&
      !path.includes('\0') &&
      posix.normalize(path) === path &&
      (path === '/' || !path.endsWith('/')),
  ),
)

/** Lossless Linux process identity: stat field 22 is clock ticks, not milliseconds. */
export const CensusLifetime = Schema.Struct({ pid: Pid, startTime: Decimal })
export type CensusLifetime = typeof CensusLifetime.Type
export const CensusStamp = Schema.Struct({
  monotonicNs: Decimal,
  wall: Schema.DateTimeUtcFromString,
})
export type CensusStamp = typeof CensusStamp.Type

export const CensusRequest = Schema.Struct({
  version: Schema.Literal(1),
  bootId: BootId,
  nonce: Nonce,
  requestedAt: CensusStamp,
  requesterUid: Count,
  authorizedRoots: Schema.Array(AbsolutePath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.makeFilter((roots) => new Set(roots).size === roots.length),
  ),
  namedLifetimes: Schema.Array(CensusLifetime).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.makeFilter(
      (lifetimes) => new Set(lifetimes.map(({ pid }) => pid)).size === lifetimes.length,
    ),
  ),
}).annotate({ identifier: 'StoreDemandCensus.Request' })
export type CensusRequest = typeof CensusRequest.Type

export const CensusUnreadableReason = Schema.Literals([
  'permission-denied',
  'identity-unreadable',
  'unstable',
  'io',
])
export type CensusUnreadableReason = typeof CensusUnreadableReason.Type
export const CensusRefusalReason = Schema.Literals([
  'unsupported-version',
  'unauthorized',
  'invalid-request',
  'boot-mismatch',
  'roots-not-authorized',
  'rate-limited',
  'busy',
  'capture-timeout',
  'response-too-large',
  'collector-failed',
])
export type CensusRefusalReason = typeof CensusRefusalReason.Type

const Coverage = Schema.Union([
  Schema.TaggedStruct('Covered', {
    lifetime: CensusLifetime,
    evidence: Schema.Union([
      Schema.TaggedStruct('OwnUidDetails', {
        cwd: Schema.Array(AbsolutePath).check(Schema.isMaxLength(1)),
        root: Schema.Array(AbsolutePath).check(Schema.isMaxLength(1)),
        fdTargets: Schema.Array(AbsolutePath),
        mapTargets: Schema.Array(AbsolutePath),
      }),
      Schema.TaggedStruct('ForeignUidProjection', { ownershipRoots: Schema.Array(AbsolutePath) }),
    ]),
  }),
  Schema.TaggedStruct('Exited', { lifetime: CensusLifetime }),
  Schema.TaggedStruct('Unreadable', {
    lifetime: CensusLifetime,
    reason: CensusUnreadableReason,
  }),
])
export const CensusResponse = Schema.Union([
  Schema.TaggedStruct('Complete', {
    version: Schema.Literal(1),
    bootId: BootId,
    nonce: Nonce,
    captureStartedAt: CensusStamp,
    captureEndedAt: CensusStamp,
    complete: Schema.Boolean,
    coverage: Schema.Array(Coverage),
    snapshot: ActivityManifest.check(
      Schema.makeFilter(
        (snapshot) =>
          Number.isSafeInteger(snapshot.epoch.storeIndex) &&
          (snapshot.processIdentities ?? []).every(({ pid }) => Number.isSafeInteger(pid)) &&
          snapshot.claims.every((claim) =>
            (claim.processes ?? []).every(({ pid }) => Number.isSafeInteger(pid)),
          ),
      ),
    ),
  }),
  Schema.TaggedStruct('Refused', {
    version: Schema.Literal(1),
    reason: CensusRefusalReason,
  }),
]).annotate({ identifier: 'StoreDemandCensus.Response' })
export type CensusResponse = typeof CensusResponse.Type

/** A transport or admission failure never grants process coverage. */
export class CensusUnavailable extends Schema.TaggedError<CensusUnavailable>()(
  'CensusUnavailable',
  {
    reason: Schema.Literals([
      'unsupported-platform',
      'namespace',
      'authentication',
      'connection',
      'deadline',
      'framing',
      'request',
      'response',
      'io',
      'admission',
    ]),
    details: Schema.optionalKey(Schema.String),
    refusalReason: Schema.optionalKey(CensusRefusalReason),
    unreadable: Schema.optionalKey(
      Schema.Struct({
        lifetime: CensusLifetime,
        reason: CensusUnreadableReason,
      }),
    ),
  },
) {}
