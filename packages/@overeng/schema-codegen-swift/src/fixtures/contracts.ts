import { Schema } from 'effect'

const Item = Schema.Struct({ title: Schema.String }).annotate({
  identifier: 'Catalog.Item',
  description: 'An item supplied by a producer.',
})
export const schemas = {
  Producer: Schema.Union([
    Schema.TaggedStruct('local', { name: Schema.String, items: Schema.Array(Item) }),
    Schema.TaggedStruct('remote', { endpoint: Schema.String, enabled: Schema.Boolean }),
    Schema.TaggedStruct('idle', {}),
  ]).annotate({ description: 'A producer selected by its wire discriminator.' }),
  PresenceSample: Schema.Struct({
    required: Schema.NullOr(Schema.String),
    optional: Schema.optionalKey(Schema.String),
    patch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Mode: Schema.Literals(['active', 'paused']),
  Scalars: Schema.Struct({
    count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    truth: Schema.Boolean,
    nothing: Schema.Null,
    labels: Schema.Array(Schema.String),
  }),
  Empty: Schema.Struct({}),
  // @effect-diagnostics-next-line schemaNumber:off -- deliberately exercises broad AST; generated scalar rejects non-finite values
  NumberValue: Schema.Number,
  IntegerValue: Schema.Int,
  ComposedLiteral: Schema.Literals(['é']),
  DistinctLiterals: Schema.Literals(['é', 'e\u0301']),
  ExactTag: Schema.Union([Schema.TaggedStruct('K', {}), Schema.TaggedStruct('other', {})]),
}
export const options = {
  filename: 'Contracts.swift',
  moduleName: 'Fixture',
  header:
    'Inputs: src/fixtures/contracts.ts and schema-codegen{,-swift}/src. Regenerate: devenv tasks run genie:run',
}
