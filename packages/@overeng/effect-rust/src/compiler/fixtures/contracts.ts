import { Schema } from 'effect'

import * as EffectRust from '../../schema/effect-rust.ts'

const Count32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 }))
const Signed32 = Schema.Int.check(Schema.isBetween({ minimum: -(2 ** 31), maximum: 2 ** 31 - 1 }))
const Count64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }),
)
const Signed64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
)
const Timestamp = Schema.DateTimeUtc.annotate({ [EffectRust.timestampPrecision]: 'millis' })

const PortableName = Schema.String.check(Schema.isPattern(/^[\p{L}]+$/iu)).annotate({
  identifier: 'PortableName',
})
const LabelKey = Schema.String.check(Schema.isPattern(/^[a-z]+$/u)).annotate({
  identifier: 'LabelKey',
})
/** Mixed portable scalar, optional, nullable, record and array compiler fixture. */
export const Portable = Schema.Struct({
  count: Count32,
  nullable: Schema.NullOr(Schema.String),
  optional: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['deploy', 'drain']),
  name: PortableName,
  labels: Schema.Record(LabelKey, Schema.String),
  nested: Schema.Array(Schema.Array(Signed32)),
})
/** Branded bounded host-name fixture using a portable full-string pattern. */
export const HostName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
  Schema.isBetweenCodePoints(3, 12),
)
  .pipe(Schema.brand('HostName'))
  .annotate({ identifier: 'HostName' })
/** Semantic unsigned-width, timestamp and branded-string compiler fixture. */
export const Extensions = Schema.Struct({
  counter: Count64,
  at: Timestamp,
  host: HostName,
})
/** Case-insensitive full-string pattern fixture. */
export const Flags = Schema.String.check(Schema.isPattern(/^abc$/iu))
const ContentDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))
  .pipe(Schema.brand('ContentDigest'))
  .annotate({ identifier: 'ContentDigest' })
const MediaType = Schema.String.check(
  Schema.isPattern(/^[a-z]+\/[a-z0-9.+-]+$/u),
  Schema.isMaxCodePoints(127),
).annotate({ identifier: 'MediaType' })
/** Content metadata fixture with semantic codecs and optional wire keys. */
export const ContentDescriptor = Schema.Struct({
  digest: ContentDigest,
  size: Count64,
  mediaType: MediaType,
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  createdAt: Timestamp,
  expiresAt: Schema.optionalKey(Schema.NullOr(Timestamp)),
})
/** Tagged deployment-event fixture with semantic fields and an empty variant. */
export const Event = Schema.Union([
  Schema.TaggedStruct('Deployed', { descriptor: ContentDescriptor, host: HostName }),
  Schema.TaggedStruct('Scaled', { delta: Signed64, replicas: Count32 }),
  Schema.TaggedStruct('Drained', {}),
])
/** Recursive labelled-tree fixture contract. */
export interface Tree {
  readonly label: string
  readonly children: readonly Tree[]
}
/** Recursive labelled-tree fixture contract. */
export const Tree = Schema.Struct({
  label: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
})
/** Recursive tagged arithmetic-expression fixture contract. */
export type Expr =
  | { readonly _tag: 'Lit'; readonly value: number }
  | { readonly _tag: 'Add'; readonly left: Expr; readonly right: Expr }
  | { readonly _tag: 'Neg'; readonly operand: Expr }
const ExprRef = Schema.suspend((): Schema.Codec<Expr> => Expr)
/** Recursive tagged arithmetic-expression fixture contract. */
export const Expr: Schema.Codec<Expr> = Schema.Union([
  Schema.TaggedStruct('Lit', { value: Signed32 }),
  Schema.TaggedStruct('Add', { left: ExprRef, right: ExprRef }),
  Schema.TaggedStruct('Neg', { operand: ExprRef }),
])
/** Complete live fixture contract set used by the shared acceptance vectors. */
export const contracts = { Portable, Extensions, Flags, ContentDescriptor, Event, Tree, Expr }
