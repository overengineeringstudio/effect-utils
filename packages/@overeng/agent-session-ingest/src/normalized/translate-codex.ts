import type { DateTime } from 'effect'

import type { CodexSessionRecord } from '../adapters/codex.ts'
import { parseMcpToolName } from './mcp-tool-name.ts'
import type { NormalizedRecord } from './schema.ts'

/** Translate a raw Codex session record into normalized records. */
export const translateCodexRecord = (
  record: CodexSessionRecord,
): ReadonlyArray<NormalizedRecord> => {
  const r = record as Record<string, unknown>
  const type = r['type'] as string | undefined
  const timestamp = r['timestamp'] as DateTime.Utc | undefined

  if (type === 'session_meta' && timestamp !== undefined) {
    const payload = r['payload'] as {
      id: string
      cwd: string
      cli_version?: string
    }
    return [
      {
        _tag: 'SessionMeta',
        sourceId: payload.id,
        sessionId: payload.id,
        cwd: payload.cwd,
        ...(payload.cli_version !== undefined && { version: payload.cli_version }),
        tool: 'codex',
        timestamp,
      },
    ]
  }

  if (type === 'response_item' && timestamp !== undefined) {
    const payload = r['payload'] as Record<string, unknown>
    const payloadType = payload['type'] as string | undefined
    if (payloadType === undefined) {
      return [
        { _tag: 'GenericEvent', sourceId: '', eventType: 'response_item', data: record, timestamp },
      ]
    }

    switch (payloadType) {
      case 'message': {
        const role = payload['role'] as string
        const content = payload['content'] as ReadonlyArray<{ type: string; text?: string }>
        const results: Array<NormalizedRecord> = []
        for (const part of content) {
          if (
            (part.type === 'input_text' || part.type === 'output_text') &&
            part.text !== undefined
          ) {
            if (role === 'user' || role === 'developer' || role === 'system') {
              results.push({
                _tag: 'UserMessage',
                sourceId: '',
                content: part.text,
                timestamp,
              })
            } else {
              results.push({
                _tag: 'AssistantText',
                sourceId: '',
                content: part.text,
                timestamp,
              })
            }
          }
        }
        return results
      }
      case 'reasoning': {
        const summary = payload['summary'] as ReadonlyArray<{ text: string }>
        return summary.map((part) => ({
          _tag: 'Thinking' as const,
          sourceId: '',
          content: part.text,
          timestamp,
        }))
      }
      case 'function_call': {
        const name = payload['name'] as string
        const args = payload['arguments'] as string
        const callId = payload['call_id'] as string
        const parsed = parseMcpToolName(name)
        let input: unknown
        try {
          input = JSON.parse(args)
        } catch {
          input = args
        }
        return [
          {
            _tag: 'ToolCallStart',
            sourceId: '',
            toolCallId: callId,
            toolName: parsed.toolName,
            ...(parsed.serverName !== '' && { serverName: parsed.serverName }),
            input,
            timestamp,
          },
        ]
      }
      case 'function_call_output': {
        const callId = payload['call_id'] as string
        const output = payload['output'] as string
        return [
          {
            _tag: 'ToolCallEnd',
            sourceId: '',
            toolCallId: callId,
            output,
            timestamp,
          },
        ]
      }
      case 'custom_tool_call': {
        const name = (payload['name'] as string | undefined) ?? ''
        const callId = (payload['call_id'] as string | undefined) ?? ''
        const parsed = parseMcpToolName(name)
        let input: unknown = payload['input']
        if (input === undefined && payload['arguments'] !== undefined) {
          try {
            input = JSON.parse(payload['arguments'] as string)
          } catch {
            input = payload['arguments']
          }
        }
        return [
          {
            _tag: 'ToolCallStart',
            sourceId: '',
            toolCallId: callId,
            toolName: parsed.toolName,
            ...(parsed.serverName !== '' && { serverName: parsed.serverName }),
            input,
            timestamp,
          },
        ]
      }
      case 'custom_tool_call_output': {
        const callId = (payload['call_id'] as string | undefined) ?? ''
        return [
          {
            _tag: 'ToolCallEnd',
            sourceId: '',
            toolCallId: callId,
            output: payload['output'],
            timestamp,
          },
        ]
      }
      default:
        return [
          {
            _tag: 'GenericEvent',
            sourceId: '',
            eventType: `response_item:${payloadType}`,
            data: record,
            timestamp,
          },
        ]
    }
  }

  if (type === 'turn_context' && timestamp !== undefined) {
    const payload = r['payload'] as { cwd: string; model?: string }
    return [
      {
        _tag: 'SessionMeta',
        sourceId: '',
        sessionId: '',
        cwd: payload.cwd,
        ...(payload.model !== undefined && { model: payload.model }),
        tool: 'codex',
        timestamp,
      },
    ]
  }

  if (type === 'event_msg' && timestamp !== undefined) {
    return [
      {
        _tag: 'GenericEvent',
        sourceId: '',
        eventType: 'event_msg',
        data: r['payload'],
        timestamp,
      },
    ]
  }

  return [
    {
      _tag: 'GenericEvent',
      sourceId: '',
      eventType: type ?? 'unknown',
      data: record,
      ...(timestamp !== undefined && { timestamp }),
    },
  ]
}
