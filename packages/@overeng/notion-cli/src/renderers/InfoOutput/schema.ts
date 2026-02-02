import { Schema } from 'effect'

const PropertyInfo = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
})

export const InfoState = Schema.Union(
  Schema.TaggedStruct('Loading', {}),
  Schema.TaggedStruct('Success', {
    dbName: Schema.String,
    dbId: Schema.String,
    dbUrl: Schema.String,
    properties: Schema.Array(PropertyInfo),
    rowCount: Schema.String,
  }),
  Schema.TaggedStruct('Error', {
    message: Schema.String,
  }),
)

export type InfoState = typeof InfoState.Type

export const InfoAction = Schema.Union(
  Schema.TaggedStruct('SetResult', {
    dbName: Schema.String,
    dbId: Schema.String,
    dbUrl: Schema.String,
    properties: Schema.Array(PropertyInfo),
    rowCount: Schema.String,
  }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

export type InfoAction = typeof InfoAction.Type

export const infoReducer = ({
  state: _state,
  action,
}: {
  state: InfoState
  action: InfoAction
}): InfoState => {
  switch (action._tag) {
    case 'SetResult':
      return {
        _tag: 'Success',
        dbName: action.dbName,
        dbId: action.dbId,
        dbUrl: action.dbUrl,
        properties: action.properties,
        rowCount: action.rowCount,
      }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
