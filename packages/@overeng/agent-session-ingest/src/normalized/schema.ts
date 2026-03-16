import { Schema } from 'effect'

/** Session metadata extracted from any provider. */
export const SessionMeta = Schema.TaggedStruct('SessionMeta', {
  sourceId: Schema.String,
  sessionId: Schema.String,
  cwd: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.DateTimeUtc),
}).annotations({ identifier: 'AgentSessionIngest.Normalized.SessionMeta' })

/** User-authored message content. */
export const UserMessage = Schema.TaggedStruct('UserMessage', {
  sourceId: Schema.String,
  messageId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  content: Schema.String,
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.UserMessage' })

/** Text content from an assistant response. */
export const AssistantText = Schema.TaggedStruct('AssistantText', {
  sourceId: Schema.String,
  messageId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  content: Schema.String,
  model: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.AssistantText' })

/** Internal reasoning/thinking content from an assistant. */
export const Thinking = Schema.TaggedStruct('Thinking', {
  sourceId: Schema.String,
  messageId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  content: Schema.String,
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.Thinking' })

/** Tool invocation with input parameters. */
export const ToolCallStart = Schema.TaggedStruct('ToolCallStart', {
  sourceId: Schema.String,
  messageId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  toolName: Schema.String,
  serverName: Schema.optional(Schema.String),
  input: Schema.Unknown,
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.ToolCallStart' })

/** Tool completion with output and error status. */
export const ToolCallEnd = Schema.TaggedStruct('ToolCallEnd', {
  sourceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  toolName: Schema.optional(Schema.String),
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.ToolCallEnd' })

/** Step start/finish marker (OpenCode-specific). */
export const StepBoundary = Schema.TaggedStruct('StepBoundary', {
  sourceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  kind: Schema.Literal('start', 'finish'),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.StepBoundary' })

/** System-level message content. */
export const SystemMessage = Schema.TaggedStruct('SystemMessage', {
  sourceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  content: Schema.Unknown,
  timestamp: Schema.DateTimeUtc,
}).annotations({ identifier: 'AgentSessionIngest.Normalized.SystemMessage' })

/** Catch-all for provider-specific events with no semantic equivalent. */
export const GenericEvent = Schema.TaggedStruct('GenericEvent', {
  sourceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  eventType: Schema.String,
  data: Schema.Unknown,
  timestamp: Schema.optional(Schema.DateTimeUtc),
}).annotations({ identifier: 'AgentSessionIngest.Normalized.GenericEvent' })

/** Provider-agnostic union of all normalized record types. */
export const NormalizedRecord = Schema.Union(
  SessionMeta,
  UserMessage,
  AssistantText,
  Thinking,
  ToolCallStart,
  ToolCallEnd,
  StepBoundary,
  SystemMessage,
  GenericEvent,
).annotations({ identifier: 'AgentSessionIngest.NormalizedRecord' })
export type NormalizedRecord = typeof NormalizedRecord.Type
