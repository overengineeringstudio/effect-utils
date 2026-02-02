import { Schema } from 'effect'

export const GenerateState = Schema.Union(
  Schema.TaggedStruct('Introspecting', { databaseId: Schema.String }),
  Schema.TaggedStruct('Generating', { schemaName: Schema.String }),
  Schema.TaggedStruct('Writing', { outputPath: Schema.String }),
  Schema.TaggedStruct('DryRun', {
    code: Schema.String,
    apiCode: Schema.optional(Schema.String),
    outputPath: Schema.String,
    apiOutputPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Done', {
    outputPath: Schema.String,
    writable: Schema.Boolean,
    apiOutputPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Error', { message: Schema.String }),
)

export type GenerateState = typeof GenerateState.Type

export const GenerateAction = Schema.Union(
  Schema.TaggedStruct('SetIntrospecting', { databaseId: Schema.String }),
  Schema.TaggedStruct('SetGenerating', { schemaName: Schema.String }),
  Schema.TaggedStruct('SetWriting', { outputPath: Schema.String }),
  Schema.TaggedStruct('SetDryRun', {
    code: Schema.String,
    apiCode: Schema.optional(Schema.String),
    outputPath: Schema.String,
    apiOutputPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetDone', {
    outputPath: Schema.String,
    writable: Schema.Boolean,
    apiOutputPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

export type GenerateAction = typeof GenerateAction.Type

export const generateReducer = ({
  state: _state,
  action,
}: {
  state: GenerateState
  action: GenerateAction
}): GenerateState => {
  switch (action._tag) {
    case 'SetIntrospecting':
      return { _tag: 'Introspecting', databaseId: action.databaseId }
    case 'SetGenerating':
      return { _tag: 'Generating', schemaName: action.schemaName }
    case 'SetWriting':
      return { _tag: 'Writing', outputPath: action.outputPath }
    case 'SetDryRun':
      return {
        _tag: 'DryRun',
        code: action.code,
        apiCode: action.apiCode,
        outputPath: action.outputPath,
        apiOutputPath: action.apiOutputPath,
      }
    case 'SetDone':
      return {
        _tag: 'Done',
        outputPath: action.outputPath,
        writable: action.writable,
        apiOutputPath: action.apiOutputPath,
      }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
