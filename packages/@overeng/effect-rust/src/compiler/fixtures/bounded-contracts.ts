import { Schema } from 'effect'

import * as EffectRust from '../../schema/effect-rust.ts'
import type { Vector } from '../mod.ts'

/** Non-primitive intervals exercise independent storage selection and validation. */
export const boundedContracts = {
  Percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  SignedByte: Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 100 })),
  SignedShort: Schema.Int.check(Schema.isBetween({ minimum: -129, maximum: 128 })),
  PinnedPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
    [EffectRust.width]: 'u32',
  }),
  Exclusive: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 101, exclusiveMinimum: true, exclusiveMaximum: true }),
  ),
  Revision: Schema.BigInt.check(
    Schema.isBetweenBigInt({ minimum: 9007199254740993n, maximum: 9007199254740999n }),
  ),
  SafeUnsigned: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  SafeSigned: Schema.Int.check(
    Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  SafeSlice: Schema.Int.check(Schema.isBetween({ minimum: 2 ** 32, maximum: 2 ** 32 + 100 })),
  SignedRevision: Schema.BigInt.check(
    Schema.isBetweenBigInt({ minimum: -9007199254740999n, maximum: -9007199254740993n }),
  ),
}

/** Exact boundaries, storage-valid outliers and fractions must agree in both languages. */
export const boundedVectors: readonly Vector[] = [
  ...['Percent', 'PinnedPercent'].flatMap((contract) => [
    { contract, name: 'minimum', input: 0, accept: true },
    { contract, name: 'maximum', input: 100, accept: true },
    { contract, name: 'below', input: -1, accept: false },
    { contract, name: 'above', input: 101, accept: false },
    { contract, name: 'fraction', input: 0.5, accept: false },
  ]),
  ...[
    { contract: 'SignedByte', minimum: -5, maximum: 100 },
    { contract: 'SignedShort', minimum: -129, maximum: 128 },
    { contract: 'Exclusive', minimum: 1, maximum: 100 },
    { contract: 'SafeUnsigned', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    { contract: 'SafeSigned', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    { contract: 'SafeSlice', minimum: 2 ** 32, maximum: 2 ** 32 + 100 },
  ].flatMap(({ contract, minimum, maximum }) => [
    { contract, name: 'minimum', input: minimum, accept: true },
    { contract, name: 'maximum', input: maximum, accept: true },
    { contract, name: 'below', input: minimum - 1, accept: false },
    { contract, name: 'above', input: maximum + 1, accept: false },
  ]),
  ...[
    { contract: 'Revision', minimum: 9007199254740993n, maximum: 9007199254740999n },
    { contract: 'SignedRevision', minimum: -9007199254740999n, maximum: -9007199254740993n },
  ].flatMap(({ contract, minimum, maximum }) => [
    { contract, name: 'minimum', input: minimum.toString(), accept: true },
    { contract, name: 'maximum', input: maximum.toString(), accept: true },
    { contract, name: 'below', input: (minimum - 1n).toString(), accept: false },
    { contract, name: 'above', input: (maximum + 1n).toString(), accept: false },
    { contract, name: 'noncanonical', input: `0${maximum}`, accept: false },
  ]),
]
