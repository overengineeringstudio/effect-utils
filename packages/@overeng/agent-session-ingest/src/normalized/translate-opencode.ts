import { DateTime } from 'effect'

import type { OpenCodeRecord } from '../adapters/opencode.ts'
import { parseMcpToolName } from './mcp-tool-name.ts'
import type { NormalizedRecord } from './schema.ts'

const epochMsToUtc = (ms: number): DateTime.Utc => DateTime.unsafeMake(ms)

/** Translate a raw OpenCode session record into normalized records. */
export const translateOpenCodeRecord = (
  record: OpenCodeRecord,
): ReadonlyArray<NormalizedRecord> => {
  switch (record._tag) {
    case 'OpenCodeSession': {
      const s = record.session
      return [
        {
          _tag: 'SessionMeta',
          sourceId: s.id,
          sessionId: s.id,
          cwd: s.directory,
          version: s.version,
          tool: 'opencode',
          timestamp: epochMsToUtc(s.time_created),
        },
      ]
    }
    case 'OpenCodeMessage': {
      const timestamp = epochMsToUtc(record.timeCreated)
      if (record.data.role === 'user') {
        return [
          {
            _tag: 'UserMessage',
            sourceId: record.sessionId,
            messageId: record.id,
            sessionId: record.sessionId,
            content: '',
            timestamp,
          },
        ]
      }
      return [
        {
          _tag: 'GenericEvent',
          sourceId: record.sessionId,
          sessionId: record.sessionId,
          eventType: `message:${record.data.role}`,
          data: record.data,
          timestamp,
        },
      ]
    }
    case 'OpenCodePart': {
      const timestamp = epochMsToUtc(record.timeCreated)
      const d = record.data as Record<string, unknown>

      switch (record.data.type) {
        case 'text':
          return [
            {
              _tag: 'AssistantText',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              content: d['text'] as string,
              timestamp,
            },
          ]
        case 'reasoning':
          return [
            {
              _tag: 'Thinking',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              content: d['text'] as string,
              timestamp,
            },
          ]
        case 'tool': {
          const tool = d['tool'] as string
          const callID = d['callID'] as string
          const state = d['state'] as {
            status: string
            input: unknown
            output?: unknown
          }
          const parsed = parseMcpToolName(tool)
          const status = state.status
          if (status === 'pending' || status === 'running') {
            return [
              {
                _tag: 'ToolCallStart',
                sourceId: record.sessionId,
                sessionId: record.sessionId,
                toolCallId: callID,
                toolName: parsed.toolName,
                ...(parsed.serverName !== '' && { serverName: parsed.serverName }),
                input: state.input,
                timestamp,
              },
            ]
          }
          return [
            {
              _tag: 'ToolCallEnd',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              toolCallId: callID,
              toolName: parsed.toolName,
              output: state.output,
              ...(status === 'error' && { isError: true }),
              timestamp,
            },
          ]
        }
        case 'step-start':
          return [
            {
              _tag: 'StepBoundary',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              kind: 'start',
              timestamp,
            },
          ]
        case 'step-finish': {
          const cost = d['cost'] as number | undefined
          const tokens = d['tokens'] as unknown
          const reason = d['reason'] as string | undefined
          return [
            {
              _tag: 'StepBoundary',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              kind: 'finish',
              ...(cost !== undefined && { cost }),
              ...(tokens !== undefined && { tokens }),
              ...(reason !== undefined && { reason }),
              timestamp,
            },
          ]
        }
        default:
          return [
            {
              _tag: 'GenericEvent',
              sourceId: record.sessionId,
              sessionId: record.sessionId,
              eventType: `part:${record.data.type}`,
              data: record.data,
              timestamp,
            },
          ]
      }
    }
  }
}
