import { Schema } from 'effect'

const PropertyInfo = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  groups: Schema.optional(Schema.Array(Schema.String)),
  relationDatabase: Schema.optional(Schema.String),
})

/** Schema for the introspect command's UI state (Loading → Success/Error). */
export const IntrospectState = Schema.Union(
  Schema.TaggedStruct('Loading', {}),
  Schema.TaggedStruct('Success', {
    dbName: Schema.String,
    dbId: Schema.String,
    dbUrl: Schema.String,
    properties: Schema.Array(PropertyInfo),
  }),
  Schema.TaggedStruct('Error', {
    message: Schema.String,
  }),
)

export type IntrospectState = typeof IntrospectState.Type

/** Actions dispatched by the introspect command to report results or errors. */
export const IntrospectAction = Schema.Union(
  Schema.TaggedStruct('SetResult', {
    dbName: Schema.String,
    dbId: Schema.String,
    dbUrl: Schema.String,
    properties: Schema.Array(PropertyInfo),
  }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

export type IntrospectAction = typeof IntrospectAction.Type

/** Reducer that applies {@link IntrospectAction} to produce the next {@link IntrospectState}. */
export const introspectReducer = ({
  state: _state,
  action,
}: {
  state: IntrospectState
  action: IntrospectAction
}): IntrospectState => {
  switch (action._tag) {
    case 'SetResult':
      return {
        _tag: 'Success',
        dbName: action.dbName,
        dbId: action.dbId,
        dbUrl: action.dbUrl,
        properties: action.properties,
      }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
