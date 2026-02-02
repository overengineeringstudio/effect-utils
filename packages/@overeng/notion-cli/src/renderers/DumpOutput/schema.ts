import { Schema } from 'effect'

export const DumpState = Schema.Union(
  Schema.TaggedStruct('Loading', {
    databaseId: Schema.String,
  }),
  Schema.TaggedStruct('Introspecting', {
    databaseId: Schema.String,
  }),
  Schema.TaggedStruct('Fetching', {
    databaseId: Schema.String,
    dbName: Schema.String,
    pageCount: Schema.Number,
    outputPath: Schema.String,
  }),
  Schema.TaggedStruct('Done', {
    pageCount: Schema.Number,
    assetsDownloaded: Schema.Number,
    assetBytes: Schema.Number,
    assetsSkipped: Schema.Number,
    failures: Schema.Number,
    outputPath: Schema.String,
  }),
  Schema.TaggedStruct('Error', {
    message: Schema.String,
  }),
)

export type DumpState = typeof DumpState.Type

export const DumpAction = Schema.Union(
  Schema.TaggedStruct('SetIntrospecting', {
    databaseId: Schema.String,
  }),
  Schema.TaggedStruct('SetFetching', {
    dbName: Schema.String,
    outputPath: Schema.String,
  }),
  Schema.TaggedStruct('AddPages', {
    count: Schema.Number,
  }),
  Schema.TaggedStruct('SetDone', {
    assetsDownloaded: Schema.Number,
    assetBytes: Schema.Number,
    assetsSkipped: Schema.Number,
    failures: Schema.Number,
  }),
  Schema.TaggedStruct('SetError', {
    message: Schema.String,
  }),
)

export type DumpAction = typeof DumpAction.Type

export const dumpReducer = ({
  state,
  action,
}: {
  state: DumpState
  action: DumpAction
}): DumpState => {
  switch (action._tag) {
    case 'SetIntrospecting':
      return { _tag: 'Introspecting', databaseId: action.databaseId }
    case 'SetFetching':
      if (state._tag !== 'Introspecting' && state._tag !== 'Loading') return state
      return {
        _tag: 'Fetching',
        databaseId: state.databaseId,
        dbName: action.dbName,
        pageCount: 0,
        outputPath: action.outputPath,
      }
    case 'AddPages':
      if (state._tag !== 'Fetching') return state
      return { ...state, pageCount: state.pageCount + action.count }
    case 'SetDone':
      if (state._tag !== 'Fetching') return state
      return {
        _tag: 'Done',
        pageCount: state.pageCount,
        assetsDownloaded: action.assetsDownloaded,
        assetBytes: action.assetBytes,
        assetsSkipped: action.assetsSkipped,
        failures: action.failures,
        outputPath: state.outputPath,
      }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
