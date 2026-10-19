import { it } from '@effect/vitest'
import { DateTime, Duration, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { doc, input, t } from './run-values.ts'
import {
  DurationSchema,
  NonNegativeDurationSchema,
  InstantSchema,
  Launch,
  LaunchSchema,
  launchReferences,
  lowerLaunch,
  Timing,
  TimingSchema,
  lowerTiming,
  Review,
  ReviewSchema,
  lowerReview,
  reviewReferences,
  normalizeDuration,
  normalizeInstant,
} from './values.ts'

const anchor = '2026-10-19T12:00:00.000Z'
const hash = 'a'.repeat(64)

describe('strict duration normalization', () => {
  it('normalizes native and Effect units immediately', () => {
    for (const value of ['1h', '60 minutes', '3600 seconds', Duration.hours(1)]) {
      expect(normalizeDuration({ input: value })).toBe('3600000ms')
      expect(Schema.decodeSync(DurationSchema)(value)).toBe('3600000ms')
    }
    expect(normalizeDuration({ input: '0.001 seconds' })).toBe('1ms')
    expect(normalizeDuration({ input: '1000000 nanos' })).toBe('1ms')
    expect(() => normalizeDuration({ input: '0.000000000000000001 weeks' })).toThrow()
  })

  it('preserves the full native u64 range using exact strings and nanos', () => {
    expect(normalizeDuration({ input: '18446744073709551615ms' })).toBe('18446744073709551615ms')
    expect(normalizeDuration({ input: '18446744073709551615 millis' })).toBe(
      '18446744073709551615ms',
    )
    expect(normalizeDuration({ input: Duration.nanos(18446744073709551615000000n) })).toBe(
      '18446744073709551615ms',
    )
    for (const value of [
      '18446744073709551616ms',
      '18446744073709551616 millis',
      '18446744073709552 seconds',
    ]) {
      expect(() => normalizeDuration({ input: value })).toThrow()
    }
  })

  it('rejects precision loss, nonfinite values, numeric inputs, and zero by default', () => {
    for (const value of [
      '0ms',
      '-1 seconds',
      'Infinity',
      '-Infinity',
      'NaN millis',
      '0.0001 seconds',
      '1.000000000000000001 millis',
      Duration.nanos(1000001n),
      Duration.infinity,
      Duration.negativeInfinity,
      Duration.millis(9007199254740992),
    ]) {
      expect(() => normalizeDuration({ input: value })).toThrow()
    }
    for (const value of [1, 0, 1n, { seconds: 1 }, [1, 0], Number.NaN]) {
      expect(() => Schema.decodeUnknownSync(DurationSchema)(value)).toThrow()
    }
    expect(normalizeDuration({ input: '0 seconds', allowZero: true })).toBe('0ms')
    expect(Schema.decodeSync(NonNegativeDurationSchema)(Duration.zero)).toBe('0ms')
    expect(() => Schema.decodeSync(NonNegativeDurationSchema)('-1 millis')).toThrow()
  })
})

describe('strict instant normalization', () => {
  it('uses Effect instants and explicit offsets, producing UTC ISO', () => {
    expect(normalizeInstant('2026-10-19T14:00:00+02:00')).toBe(anchor)
    expect(normalizeInstant(DateTime.makeUnsafe(anchor))).toBe(anchor)
    expect(normalizeInstant('2026-10-19T12:00:00.123000Z')).toBe('2026-10-19T12:00:00.123Z')
    expect(normalizeInstant('0000-01-01T00:00:00Z')).toBe('0000-01-01T00:00:00.000Z')
    expect(normalizeInstant('9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z')
  })

  it('rejects offsetless dates, calendar rollover, overflow, and lost fractions', () => {
    for (const value of [
      '2026-10-19',
      '2026-10-19T12:00:00',
      '2026-02-29T00:00:00Z',
      '2026-10-19T24:00:00Z',
      '2026-10-19T12:00:00.0001Z',
      '2026-10-19T12:00:60Z',
      '+010000-01-01T00:00:00Z',
      '9999-12-31T23:59:59-01:00',
    ]) {
      expect(() => normalizeInstant(value)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(InstantSchema)(new Date())).toThrow()
    expect(() => Schema.decodeUnknownSync(InstantSchema)(0)).toThrow()
  })
})

describe('canonical launch values', () => {
  it('preserves literal argv, environment, cwd and unset', () => {
    const value = Launch.argv({
      argv: ['printf', '$HOME'],
      cwd: '/tmp/a b',
      env: { MODE: '' },
      unset: ['TOKEN'],
    })
    expect(value).toEqual({
      _tag: 'Argv',
      argv: ['printf', '$HOME'],
      cwd: '/tmp/a b',
      env: { MODE: '' },
      unset: ['TOKEN'],
    })
    expect(Launch.from(lowerLaunch(value))).toEqual(value)
    expect(Launch.shell({ command: 'printf "$HOME"' })).toEqual({
      _tag: 'Shell',
      command: 'printf "$HOME"',
    })
    expect(Launch.argv({ argv: ['printf', ''] })).toEqual({ _tag: 'Argv', argv: ['printf', ''] })
    expect(Object.isFrozen(value)).toBe(true)
    if (value._tag === 'Argv') expect(Object.isFrozen(value.argv)).toBe(true)
    expect(Object.isFrozen(value.env)).toBe(true)
    expect(Object.isFrozen(value.unset)).toBe(true)
  })

  it('rejects empty argv and executables, mixed variants and excess properties', () => {
    for (const value of [
      { _tag: 'Argv', argv: [] },
      { _tag: 'Argv', argv: [''] },
      { _tag: 'Shell', command: '' },
      { _tag: 'Shell', command: 'true', argv: ['true'] },
      { _tag: 'Shell', command: 'true', policy: {} },
      { _tag: 'Shell', command: 'true', env: { 'BAD-NAME': 'x' } },
      { _tag: 'Shell', command: 'true', env: { KEY: '' }, unset: ['KEY'] },
    ])
      expect(() => Schema.decodeUnknownSync(LaunchSchema)(value)).toThrow()
    expect(() => Launch.from({ command: 'true', argv: ['false'] })).toThrow()
    const unsupportedLaunch = { command: 'true', cwd: '/tmp', policy: {} }
    expect(() => Launch.shell(unsupportedLaunch)).toThrow()
    expect(Schema.is(LaunchSchema)({ _tag: 'Shell', command: 'true', argv: ['true'] })).toBe(false)
    expect(Schema.is(LaunchSchema)({ _tag: 'Argv', argv: ['true'], command: 'true' })).toBe(false)
    expect(Schema.is(LaunchSchema)({ _tag: 'Shell', command: 'true', policy: {} })).toBe(false)
  })

  it('retains reference identities across command, argv, env and cwd normalization', () => {
    const name = input.text('name')
    const command = Launch.shell({
      command: t`echo ${name}`,
      cwd: t`/tmp/${name}`,
      env: { NAME: t`${name}` },
    })
    expect(launchReferences(command)).toEqual([name, name, name])
    expect(launchReferences(Launch.argv({ argv: ['echo', t`${name}`] }))).toEqual([name])
    expect(lowerLaunch(command)).toEqual({
      command: 'echo ${input.name}',
      cwd: '/tmp/${input.name}',
      env: { NAME: '${input.name}' },
    })
  })
})

describe('canonical timing values', () => {
  it('normalizes each native-shaped form and preserves calendar wall time', () => {
    const every = Timing.every({
      every: Duration.hours(1),
      anchor: '2026-10-19T14:00:00+02:00',
      catchUp: 'latest',
    })
    expect(every).toEqual({ _tag: 'Every', every: '3600000ms', anchor, catchUp: 'latest' })
    const calendar = Timing.calendar({
      at: '09:30',
      timezone: 'Europe/Berlin',
      days: ['Mon'],
      catchUp: 'latest',
    })
    expect(Timing.from(lowerTiming(calendar))).toEqual(calendar)
    expect(Timing.at(anchor)).toEqual({ _tag: 'At', at: anchor })
    expect(Object.isFrozen(calendar)).toBe(true)
    if (calendar._tag === 'Calendar') expect(Object.isFrozen(calendar.days)).toBe(true)
  })

  it('rejects mixed forms, invalid calendar values, and unsupported catch-up', () => {
    for (const value of [
      { _tag: 'At', at: anchor, every: '1h' },
      { _tag: 'Every', every: '1h', anchor, catchUp: 'skip' },
      { _tag: 'Calendar', at: '24:00', timezone: 'UTC' },
      { _tag: 'Calendar', at: '09:00', timezone: 'Not/AZone' },
      { _tag: 'Calendar', at: '09:00', timezone: 'UTC', days: ['Mon', 'Tue'] },
      { _tag: 'Calendar', at: '09:00', timezone: 'UTC', policy: {} },
    ])
      expect(() => Schema.decodeUnknownSync(TimingSchema)(value)).toThrow()
    const outerExcess = { calendar: { at: '09:00', timezone: 'UTC' }, policy: {} }
    const innerExcess = { calendar: { at: '09:00', timezone: 'UTC', policy: {} } }
    expect(() => Timing.from(outerExcess)).toThrow()
    expect(() => Timing.from(innerExcess)).toThrow()
  })
})

describe('canonical review values', () => {
  it('lowers graph, file and exact pinned document subjects without escaping paths', () => {
    for (const value of [
      Review.subject('mission/example'),
      Review.file({ host: 'dev1', path: '/tmp/a b:report.md' }),
      Review.pinned(`doc/example/acceptance@${hash}`),
    ]) {
      expect(Review.from(lowerReview(value))).toEqual(value)
    }
    expect(lowerReview(Review.file({ host: 'dev1', path: '/tmp/a b:report.md' }))).toBe(
      'file/dev1:/tmp/a b:report.md',
    )
    expect(Review.subject('file/dev1:/tmp/report')).toEqual(
      Review.file({ host: 'dev1', path: '/tmp/report' }),
    )
    expect(Review.subject(`doc/example@${hash}`)).toEqual(Review.pinned(`doc/example@${hash}`))
    expect(Object.isFrozen(Review.subject('mission/example'))).toBe(true)
  })

  it('rejects unpinned, interpolated or malformed pinned documents and traversal', () => {
    for (const reference of [
      'doc/example',
      `doc/example@${'a'.repeat(63)}`,
      `doc/example@${'z'.repeat(64)}`,
      `doc/${'${input.name}'}@${hash}`,
      `mission/example@${hash}`,
    ]) {
      expect(() => Review.pinned(reference)).toThrow()
    }
    for (const path of ['relative', '/tmp/../report', '/tmp/..'])
      expect(() => Review.file({ host: 'dev1', path })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReviewSchema)({
        _tag: 'Subject',
        subject: 'mission/example',
        policy: {},
      }),
    ).toThrow()
  })

  it('retains imported subject references until tree resolution', () => {
    const ref = {
      _tag: 'SubjectRef',
      kind: 'mission',
      url: 'file:///subjects/example/mission.ts',
    } as const
    const review = Review.subject(ref)
    expect(review).toEqual({ _tag: 'Subject', subject: ref })
    expect(() => lowerReview(review)).toThrow('must be resolved')
  })

  it('retains exact run reference identities for human-gate validation', () => {
    const name = input.text('name')
    for (const review of [
      Review.subject(name),
      Review.subject(t`doc/example/${name}`),
      Review.subject(doc`doc/example/${name}`),
    ]) {
      expect(reviewReferences(review)).toEqual([name])
    }
  })
})

it.prop(
  'duration normalization is idempotent across native and Effect forms',
  [Schema.Int],
  ([integer]) => {
    const millis = BigInt(Math.abs(integer % 1000000000)) + 1n
    const canonical = normalizeDuration({ input: Duration.nanos(millis * 1000000n) })
    expect(normalizeDuration({ input: canonical })).toBe(canonical)
    expect(normalizeDuration({ input: `${millis} millis` })).toBe(canonical)
  },
)

it.prop('instant normalization is idempotent', [Schema.Int], ([integer]) => {
  const instant = DateTime.makeUnsafe(integer % 1000000000000)
  const canonical = normalizeInstant(instant)
  expect(normalizeInstant(canonical)).toBe(canonical)
})

it.prop(
  'launch normalization and native-shaped round-trip are idempotent',
  [Schema.NonEmptyString],
  ([command]) => {
    for (const value of [Launch.shell({ command: command }), Launch.argv({ argv: [command] })]) {
      expect(Schema.decodeSync(LaunchSchema)(value)).toEqual(value)
      expect(Launch.from(lowerLaunch(value))).toEqual(value)
    }
  },
)

it.prop(
  'timing normalization and native-shaped round-trip are idempotent',
  [Schema.Int],
  ([integer]) => {
    for (const value of [
      Timing.at(anchor),
      Timing.every({ every: `${BigInt(Math.abs(integer % 1000000000)) + 1n}ms`, anchor }),
      Timing.calendar({ at: '09:00', timezone: 'UTC' }),
    ]) {
      expect(Schema.decodeSync(TimingSchema)(value)).toEqual(value)
      expect(Timing.from(lowerTiming(value))).toEqual(value)
    }
  },
)

it.prop(
  'review normalization and native-shaped round-trip are idempotent',
  [Schema.Int],
  ([integer]) => {
    const suffix = String(Math.abs(integer % 1000000000))
    for (const value of [
      Review.subject(`mission/example-${suffix}`),
      Review.file({ host: 'dev1', path: `/tmp/${suffix}` }),
      Review.pinned(`doc/example-${suffix}@${hash}`),
    ]) {
      expect(Schema.decodeSync(ReviewSchema)(value)).toEqual(value)
      expect(Review.from(lowerReview(value))).toEqual(value)
    }
  },
)
