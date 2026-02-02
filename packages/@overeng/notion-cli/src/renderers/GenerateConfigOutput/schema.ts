import { Schema } from 'effect'

const DatabaseEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literal('pending', 'introspecting', 'generating', 'writing', 'done', 'error'),
  outputPath: Schema.optional(Schema.String),
})

/** Schema for the generate-config command's UI state (Loading → Running → Done/Error). */
export const GenerateConfigState = Schema.Union(
  Schema.TaggedStruct('Loading', {
    configPath: Schema.String,
  }),
  Schema.TaggedStruct('Running', {
    configPath: Schema.String,
    databases: Schema.Array(DatabaseEntry),
  }),
  Schema.TaggedStruct('Done', {
    configPath: Schema.String,
    count: Schema.Number,
  }),
  Schema.TaggedStruct('Error', {
    message: Schema.String,
  }),
)

export type GenerateConfigState = typeof GenerateConfigState.Type

/** Actions dispatched during config-based generation to update database progress and completion status. */
export const GenerateConfigAction = Schema.Union(
  Schema.TaggedStruct('SetConfig', {
    configPath: Schema.String,
    databases: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        outputPath: Schema.String,
      }),
    ),
  }),
  Schema.TaggedStruct('UpdateDatabase', {
    id: Schema.String,
    status: Schema.Literal('pending', 'introspecting', 'generating', 'writing', 'done', 'error'),
    name: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetDone', {
    count: Schema.Number,
  }),
  Schema.TaggedStruct('SetError', {
    message: Schema.String,
  }),
)

export type GenerateConfigAction = typeof GenerateConfigAction.Type

/** Reducer that applies {@link GenerateConfigAction} to produce the next {@link GenerateConfigState}. */
export const generateConfigReducer = ({
  state,
  action,
}: {
  state: GenerateConfigState
  action: GenerateConfigAction
}): GenerateConfigState => {
  switch (action._tag) {
    case 'SetConfig':
      return {
        _tag: 'Running',
        configPath: action.configPath,
        databases: action.databases.map((db) => ({
          id: db.id,
          name: db.name,
          status: 'pending' as const,
          outputPath: db.outputPath,
        })),
      }
    case 'UpdateDatabase':
      if (state._tag !== 'Running') return state
      return {
        ...state,
        databases: state.databases.map((db) =>
          db.id === action.id
            ? {
                ...db,
                status: action.status,
                ...(action.name !== undefined ? { name: action.name } : {}),
              }
            : db,
        ),
      }
    case 'SetDone':
      if (state._tag !== 'Running') return state
      return { _tag: 'Done', configPath: state.configPath, count: action.count }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
