import type { DateTime } from 'effect'

import type { ClaudeAssistantContentBlock, ClaudeSessionRecord } from '../adapters/claude.ts'
import { parseMcpToolName } from './mcp-tool-name.ts'
import type { NormalizedRecord } from './schema.ts'

const extractTextFromUserContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content) === true) {
    return content
      .filter(
        (block: unknown): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('\n')
  }
  return String(content)
}

const extractToolResultsFromUserContent = (
  content: unknown,
): ReadonlyArray<{
  tool_use_id: string
  content: unknown
  is_error?: boolean
}> => {
  if (Array.isArray(content) !== true) return []
  return content.filter(
    (
      block: unknown,
    ): block is {
      type: 'tool_result'
      tool_use_id: string
      content: unknown
      is_error?: boolean
    } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result' &&
      typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string',
  )
}

interface ContentBlockContext {
  readonly sourceId: string
  readonly sessionId: string
  readonly messageId?: string
  readonly timestamp: DateTime.Utc
  readonly model?: string
}

const translateAssistantContentBlock = (options: {
  block: ClaudeAssistantContentBlock
  context: ContentBlockContext
}): ReadonlyArray<NormalizedRecord> => {
  const { block, context } = options
  const b = block as Record<string, unknown>
  switch (block.type) {
    case 'text':
      return [
        {
          _tag: 'AssistantText',
          sourceId: context.sourceId,
          messageId: context.messageId,
          sessionId: context.sessionId,
          content: b['text'] as string,
          model: context.model,
          timestamp: context.timestamp,
        },
      ]
    case 'thinking':
      return [
        {
          _tag: 'Thinking',
          sourceId: context.sourceId,
          messageId: context.messageId,
          sessionId: context.sessionId,
          content: b['thinking'] as string,
          timestamp: context.timestamp,
        },
      ]
    case 'tool_use': {
      const parsed = parseMcpToolName(b['name'] as string)
      return [
        {
          _tag: 'ToolCallStart',
          sourceId: context.sourceId,
          messageId: context.messageId,
          sessionId: context.sessionId,
          toolCallId: b['id'] as string,
          toolName: parsed.toolName,
          ...(parsed.serverName !== '' && { serverName: parsed.serverName }),
          input: b['input'],
          timestamp: context.timestamp,
        },
      ]
    }
    case 'server_tool_use': {
      const parsed = parseMcpToolName(b['name'] as string)
      return [
        {
          _tag: 'ToolCallStart',
          sourceId: context.sourceId,
          messageId: context.messageId,
          sessionId: context.sessionId,
          toolCallId: b['id'] as string,
          toolName: parsed.toolName,
          ...(parsed.serverName !== '' && { serverName: parsed.serverName }),
          input: b['input'],
          timestamp: context.timestamp,
        },
      ]
    }
    case 'tool_result':
      return [
        {
          _tag: 'ToolCallEnd',
          sourceId: context.sourceId,
          sessionId: context.sessionId,
          toolCallId: b['tool_use_id'] as string,
          output: b['content'],
          ...(b['is_error'] !== undefined && { isError: b['is_error'] as boolean }),
          timestamp: context.timestamp,
        },
      ]
    case 'server_tool_result':
      return [
        {
          _tag: 'ToolCallEnd',
          sourceId: context.sourceId,
          sessionId: context.sessionId,
          toolCallId: b['tool_use_id'] as string,
          output: b['content'],
          timestamp: context.timestamp,
        },
      ]
    default:
      return []
  }
}

/** Translate a raw Claude session record into normalized records. */
export const translateClaudeRecord = (
  record: ClaudeSessionRecord,
): ReadonlyArray<NormalizedRecord> => {
  const r = record as Record<string, unknown>
  switch (record.type) {
    case 'user': {
      const message = r['message'] as { content: unknown }
      const results: Array<NormalizedRecord> = []
      const text = extractTextFromUserContent(message.content)
      if (text.length > 0) {
        results.push({
          _tag: 'UserMessage',
          sourceId: record.sessionId as string,
          messageId: r['uuid'] as string,
          sessionId: record.sessionId as string,
          content: text,
          timestamp: record.timestamp as DateTime.Utc,
        })
      }
      for (const toolResult of extractToolResultsFromUserContent(message.content)) {
        results.push({
          _tag: 'ToolCallEnd',
          sourceId: record.sessionId as string,
          sessionId: record.sessionId as string,
          toolCallId: toolResult.tool_use_id,
          output: toolResult.content,
          ...(toolResult.is_error !== undefined && { isError: toolResult.is_error }),
          timestamp: record.timestamp as DateTime.Utc,
        })
      }
      return results
    }
    case 'assistant': {
      const message = r['message'] as {
        content: ReadonlyArray<ClaudeAssistantContentBlock>
        model?: string
      }
      const context: ContentBlockContext = {
        sourceId: record.sessionId as string,
        sessionId: record.sessionId as string,
        messageId: r['uuid'] as string,
        timestamp: record.timestamp as DateTime.Utc,
        ...(message.model !== undefined && { model: message.model }),
      }
      return message.content.flatMap((block) => translateAssistantContentBlock({ block, context }))
    }
    case 'system':
      return [
        {
          _tag: 'SystemMessage',
          sourceId: record.sessionId as string,
          sessionId: record.sessionId as string,
          content: r['content'],
          timestamp: record.timestamp as DateTime.Utc,
        },
      ]
    case 'progress':
      return [
        {
          _tag: 'GenericEvent',
          sourceId: record.sessionId as string,
          sessionId: record.sessionId as string,
          eventType: 'progress',
          data: r['data'],
          timestamp: record.timestamp as DateTime.Utc,
        },
      ]
    case 'queue-operation':
      return [
        {
          _tag: 'GenericEvent',
          sourceId: record.sessionId as string,
          sessionId: record.sessionId as string,
          eventType: `queue-operation:${r['operation'] as string}`,
          data: record,
          timestamp: record.timestamp as DateTime.Utc,
        },
      ]
    default:
      return [
        {
          _tag: 'GenericEvent',
          sourceId: record.sessionId ?? '',
          ...(record.sessionId !== undefined && { sessionId: record.sessionId }),
          eventType: record.type,
          data: record,
          ...(record.timestamp !== undefined && { timestamp: record.timestamp }),
        },
      ]
  }
}
