import { Schema } from 'effect'

const PropertyChange = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal('added', 'removed', 'type_changed'),
  liveType: Schema.optional(Schema.String),
  liveTransform: Schema.optional(Schema.String),
  generatedTransformKey: Schema.optional(Schema.String),
})

const OptionsChange = Schema.Struct({
  name: Schema.String,
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
})

export const DiffState = Schema.Union(
  Schema.TaggedStruct('Loading', {}),
  Schema.TaggedStruct('Success', {
    databaseId: Schema.String,
    filePath: Schema.String,
    properties: Schema.Array(PropertyChange),
    options: Schema.Array(OptionsChange),
    hasDifferences: Schema.Boolean,
  }),
  Schema.TaggedStruct('NoDifferences', {
    databaseId: Schema.String,
    filePath: Schema.String,
  }),
  Schema.TaggedStruct('Error', {
    message: Schema.String,
  }),
)

export type DiffState = typeof DiffState.Type

export const DiffAction = Schema.Union(
  Schema.TaggedStruct('SetResult', {
    databaseId: Schema.String,
    filePath: Schema.String,
    properties: Schema.Array(PropertyChange),
    options: Schema.Array(OptionsChange),
    hasDifferences: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetNoDifferences', {
    databaseId: Schema.String,
    filePath: Schema.String,
  }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

export type DiffAction = typeof DiffAction.Type

export const diffReducer = ({
  state: _state,
  action,
}: {
  state: DiffState
  action: DiffAction
}): DiffState => {
  switch (action._tag) {
    case 'SetResult':
      return {
        _tag: 'Success',
        databaseId: action.databaseId,
        filePath: action.filePath,
        properties: action.properties,
        options: action.options,
        hasDifferences: action.hasDifferences,
      }
    case 'SetNoDifferences':
      return {
        _tag: 'NoDifferences',
        databaseId: action.databaseId,
        filePath: action.filePath,
      }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
