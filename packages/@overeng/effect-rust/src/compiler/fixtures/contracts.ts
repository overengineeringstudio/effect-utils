import { Schema } from 'effect'
import * as Wire from '../../schema/wire.ts'

const PortableName = Schema.String.check(Wire.pattern('^[\\p{L}]+$', 'iu')).annotate({ identifier: 'PortableName' })
const LabelKey = Schema.String.check(Wire.pattern('^[a-z]+$')).annotate({ identifier: 'LabelKey' })
export const Portable = Schema.Struct({
  count: Wire.U32,
  nullable: Schema.NullOr(Schema.String),
  optional: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['deploy', 'drain']),
  name: PortableName,
  labels: Schema.Record(LabelKey, Schema.String),
  nested: Schema.Array(Schema.Array(Wire.I32)),
})
export const HostName = Schema.String.check(Wire.pattern('^[a-z][a-z0-9-]*$'), Schema.isBetweenCodePoints(3, 12)).pipe(Schema.brand('HostName')).annotate({ identifier: 'HostName' })
export const Extensions = Schema.Struct({ counter: Wire.U64, at: Wire.TimestampMillis, host: HostName })
export const Flags = Schema.String.check(Wire.pattern('^abc$', 'iu'))
const ContentDigest = Schema.String.check(Wire.pattern('^sha256:[0-9a-f]{64}$')).pipe(Schema.brand('ContentDigest')).annotate({ identifier: 'ContentDigest' })
const MediaType = Schema.String.check(Wire.pattern('^[a-z]+/[a-z0-9.+-]+$'), Schema.isMaxCodePoints(127)).annotate({ identifier: 'MediaType' })
export const ContentDescriptor = Schema.Struct({
  digest: ContentDigest, size: Wire.U64, mediaType: MediaType,
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  createdAt: Wire.TimestampMillis, expiresAt: Schema.optionalKey(Schema.NullOr(Wire.TimestampMillis)),
})
export const Event = Schema.Union([
  Schema.TaggedStruct('Deployed', { descriptor: ContentDescriptor, host: HostName }),
  Schema.TaggedStruct('Scaled', { delta: Wire.I64, replicas: Wire.U32 }),
  Schema.TaggedStruct('Drained', {}),
])
export interface Tree { readonly label: string; readonly children: readonly Tree[] }
export const Tree = Schema.Struct({ label: Schema.String, children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)) })
export type Expr = { readonly _tag: 'Lit'; readonly value: number } | { readonly _tag: 'Add'; readonly left: Expr; readonly right: Expr } | { readonly _tag: 'Neg'; readonly operand: Expr }
const ExprRef = Schema.suspend((): Schema.Codec<Expr> => Expr)
export const Expr: Schema.Codec<Expr> = Schema.Union([
  Schema.TaggedStruct('Lit', { value: Wire.I32 }),
  Schema.TaggedStruct('Add', { left: ExprRef, right: ExprRef }),
  Schema.TaggedStruct('Neg', { operand: ExprRef }),
])
export const contracts = { Portable, Extensions, Flags, ContentDescriptor, Event, Tree, Expr }
