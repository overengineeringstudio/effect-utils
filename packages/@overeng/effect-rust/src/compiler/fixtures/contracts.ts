import { Schema } from 'effect'

import * as Wire from '../../schema/wire.ts'

const PortableName = Schema.String.check(Wire.pattern('^[\\p{L}]+$', 'iu')).annotate({
  identifier: 'PortableName',
})
const LabelKey = Schema.String.check(Wire.pattern('^[a-z]+$')).annotate({ identifier: 'LabelKey' })
/** Mixed portable scalar, optional, nullable, record and array compiler fixture. */
export const Portable = Schema.Struct({
  count: Wire.U32,
  nullable: Schema.NullOr(Schema.String),
  optional: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['deploy', 'drain']),
  name: PortableName,
  labels: Schema.Record(LabelKey, Schema.String),
  nested: Schema.Array(Schema.Array(Wire.I32)),
})
/** Branded bounded host-name fixture using a portable full-string pattern. */
export const HostName = Schema.String.check(
  Wire.pattern('^[a-z][a-z0-9-]*$'),
  Schema.isBetweenCodePoints(3, 12),
)
  .pipe(Schema.brand('HostName'))
  .annotate({ identifier: 'HostName' })
/** Semantic unsigned-width, timestamp and branded-string compiler fixture. */
export const Extensions = Schema.Struct({
  counter: Wire.U64,
  at: Wire.TimestampMillis,
  host: HostName,
})
/** Case-insensitive full-string pattern fixture. */
export const Flags = Schema.String.check(Wire.pattern('^abc$', 'iu'))
const ContentDigest = Schema.String.check(Wire.pattern('^sha256:[0-9a-f]{64}$'))
  .pipe(Schema.brand('ContentDigest'))
  .annotate({ identifier: 'ContentDigest' })
const MediaType = Schema.String.check(
  Wire.pattern('^[a-z]+/[a-z0-9.+-]+$'),
  Schema.isMaxCodePoints(127),
).annotate({ identifier: 'MediaType' })
/** Content metadata fixture with semantic codecs and optional wire keys. */
export const ContentDescriptor = Schema.Struct({
  digest: ContentDigest,
  size: Wire.U64,
  mediaType: MediaType,
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  createdAt: Wire.TimestampMillis,
  expiresAt: Schema.optionalKey(Schema.NullOr(Wire.TimestampMillis)),
})
/** Tagged deployment-event fixture with semantic fields and an empty variant. */
export const Event = Schema.Union([
  Schema.TaggedStruct('Deployed', { descriptor: ContentDescriptor, host: HostName }),
  Schema.TaggedStruct('Scaled', { delta: Wire.I64, replicas: Wire.U32 }),
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
  Schema.TaggedStruct('Lit', { value: Wire.I32 }),
  Schema.TaggedStruct('Add', { left: ExprRef, right: ExprRef }),
  Schema.TaggedStruct('Neg', { operand: ExprRef }),
])
/** Complete live fixture contract set used by the shared acceptance vectors. */
export const contracts = { Portable, Extensions, Flags, ContentDescriptor, Event, Tree, Expr }
