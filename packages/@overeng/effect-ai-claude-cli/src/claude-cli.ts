/**
 * Claude CLI LanguageModel provider for Effect AI
 *
 * Implements the LanguageModel interface by delegating to the `claude` CLI,
 * allowing use without API keys by re-using Claude CLI authentication.
 */
import { AiError, LanguageModel, type Prompt, type Response } from '@effect/ai'
import { Command, CommandExecutor } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect, Exit, flow, JSONSchema, Layer, Ref, Scope, Stream } from 'effect'

import {
  ClaudeCliAuthError,
  ClaudeCliExitError,
  type ClaudeCliError,
  ClaudeCliNotFoundError,
  ClaudeCliNotLoggedInError,
  ClaudeCliParseError,
  ClaudeCliRateLimitError,
} from './errors.ts'

// ============================================================================
// Internal helpers (referenced by exports below)
// ============================================================================

/** Schema for Claude CLI JSON output */
interface ClaudeCliJsonOutput {
  readonly type: 'result'
  readonly subtype: 'success' | 'error'
  readonly result?: string
  readonly total_cost_usd?: number
  readonly session_id?: string
}

const formatCommandForDisplay = (opts: { command: string; args: readonly string[] }): string => {
  const parts = [opts.command, ...opts.args].map((part) => {
    if (part.length === 0) return "''"
    if (/^[A-Za-z0-9_./:-]+$/.test(part)) return part
    return JSON.stringify(part)
  })

  return parts.join(' ')
}

const truncateForDisplay = (opts: { text: string; maxChars: number }): string => {
  const trimmed = opts.text.trim()
  if (trimmed.length <= opts.maxChars) return trimmed
  return `${trimmed.slice(0, opts.maxChars)}\n… (truncated ${trimmed.length - opts.maxChars} chars)`
}

/** Converts Effect AI prompt to a string for claude CLI */
const promptToString = (opts: {
  prompt: Prompt.Prompt
  responseFormat: LanguageModel.ProviderOptions['responseFormat']
}): string => {
  const parts: string[] = []

  for (const message of opts.prompt.content) {
    if (message.role === 'system') {
      // SystemMessage has content as string
      parts.push(`[System]: ${message.content}`)
    } else if (message.role === 'user') {
      // UserMessage has content as array of parts
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push(part.text)
        }
      }
    } else if (message.role === 'assistant') {
      // AssistantMessage has content as array of parts
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push(`[Assistant]: ${part.text}`)
        }
      }
    }
  }

  // Add JSON schema instructions if JSON response format is requested
  if (opts.responseFormat.type === 'json') {
    const jsonSchema = JSONSchema.make(opts.responseFormat.schema)
    parts.push(
      `[System]: CRITICAL: Your response must be ONLY raw JSON. Do NOT use markdown code blocks (\`\`\`). Do NOT add any explanation before or after. Start your response with { and end with }. The JSON must conform to this schema:\n${JSON.stringify(jsonSchema, null, 2)}`,
    )
  }

  return parts.join('\n\n')
}

/** Strip markdown code blocks from text (for JSON responses) */
const stripMarkdownCodeBlocks = (text: string): string => {
  // Remove ```json ... ``` or ``` ... ``` wrappers
  const codeBlockMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m)
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim()
  }
  return text.trim()
}

/** Safely parse JSON, returning undefined on failure */
const safeParseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Wrap platform errors into appropriate ClaudeCliError */
const wrapPlatformError = (error: PlatformError): ClaudeCliError => {
  const message = error.message.toLowerCase()

  // Check if CLI binary was not found
  if (
    message.includes('enoent') ||
    message.includes('not found') ||
    message.includes('no such file')
  ) {
    return new ClaudeCliNotFoundError({
      message: 'Claude CLI not found. Ensure `claude` is installed and available in PATH.',
      cause: error,
    })
  }

  // Generic platform error - wrap as exit error
  return new ClaudeCliExitError({
    message: `Platform error: ${error.message}`,
    exitCode: -1,
    stderr: '',
    stdout: '',
    command: 'claude',
  })
}

/** Convert ClaudeCliError to AiError.AiError for LanguageModel interface compatibility */
const toAiError = (error: ClaudeCliError): AiError.AiError =>
  new AiError.UnknownError({
    module: 'claude-cli',
    method: error._tag,
    description: error.message,
    cause: error,
  })

/** Compose wrapPlatformError and toAiError for use in mapError */
const platformToAiError = flow(wrapPlatformError, toAiError)

// ============================================================================
// Exports
// ============================================================================

/** Options for the Claude CLI provider */
export interface ClaudeCliOptions {
  /** Model to use (e.g. 'sonnet', 'opus', 'haiku') */
  readonly model?: string
  /** Additional tools to allow */
  readonly allowedTools?: string
}

/** Classify CLI errors based on output patterns */
export const classifyError = (opts: {
  exitCode: number
  stdout: string
  stderr: string
  command: string
}): ClaudeCliError => {
  const combined = `${opts.stdout} ${opts.stderr}`.toLowerCase()

  // Check for login-related errors
  if (
    combined.includes('not logged in') ||
    combined.includes('login required') ||
    combined.includes('please log in') ||
    combined.includes('authentication required')
  ) {
    return new ClaudeCliNotLoggedInError({
      message: 'Claude CLI requires login. Run `claude login` to authenticate.',
    })
  }

  // Check for auth errors (expired/invalid)
  if (
    combined.includes('unauthorized') ||
    combined.includes('token expired') ||
    combined.includes('invalid token') ||
    combined.includes('session expired')
  ) {
    return new ClaudeCliAuthError({
      message: 'Claude CLI authentication failed. Try `claude login` to re-authenticate.',
    })
  }

  // Check for rate limiting
  if (
    combined.includes('rate limit') ||
    combined.includes('too many requests') ||
    combined.includes('quota exceeded')
  ) {
    return new ClaudeCliRateLimitError({
      message: 'Rate limited by Claude API. Please wait before retrying.',
    })
  }

  // Default: generic exit error with full context
  return new ClaudeCliExitError({
    message: `Claude CLI exited with code ${opts.exitCode}`,
    exitCode: opts.exitCode,
    stderr: truncateForDisplay({ text: opts.stderr, maxChars: 20_000 }),
    stdout: truncateForDisplay({ text: opts.stdout, maxChars: 20_000 }),
    command: opts.command,
  })
}

/** Creates a LanguageModel that delegates to claude CLI */
export const make = Effect.fnUntraced(function* (options: ClaudeCliOptions = {}) {
  const executor = yield* CommandExecutor.CommandExecutor

  const generateText = (
    providerOptions: LanguageModel.ProviderOptions,
  ): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError> =>
    Effect.gen(function* () {
      const promptText = promptToString({
        prompt: providerOptions.prompt,
        responseFormat: providerOptions.responseFormat,
      })

      const args = [
        '-p', // print mode
        '--output-format',
        'json',
        '--tools',
        '', // disable tools for simple text generation
      ]

      if (options.model) {
        args.push('--model', options.model)
      }

      const command = Command.make('claude', ...args).pipe(Command.stdin('pipe'))
      const commandDisplay = formatCommandForDisplay({
        command: 'claude',
        args,
      })

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(command)

          // Write prompt to stdin
          yield* Stream.make(new TextEncoder().encode(promptText)).pipe(Stream.run(process.stdin))

          const collectStdout = Stream.runCollect(Stream.decodeText(process.stdout)).pipe(
            Effect.map((chunks) => Array.from(chunks).join('')),
          )

          const collectStderr = Stream.runCollect(Stream.decodeText(process.stderr)).pipe(
            Effect.map((chunks) => Array.from(chunks).join('')),
          )

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collectStdout, collectStderr, process.exitCode],
            { concurrency: 'unbounded' },
          )

          return { stdout, stderr, exitCode }
        }),
      ).pipe(Effect.mapError(wrapPlatformError))

      if (result.exitCode !== 0) {
        return yield* classifyError({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          command: commandDisplay,
        })
      }

      const lines = result.stdout.trim().split('\n')
      let resultText = ''

      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = safeParseJson<ClaudeCliJsonOutput>(line)
        if (!parsed) continue
        if (parsed.type === 'result' && parsed.subtype === 'success' && parsed.result) {
          resultText = parsed.result
        } else if (parsed.type === 'result' && parsed.subtype === 'error') {
          // Classify the error based on the result message
          const errorMessage = parsed.result ?? 'Unknown error'
          return yield* classifyError({
            exitCode: 1,
            stdout: errorMessage,
            stderr: '',
            command: commandDisplay,
          })
        }
      }

      if (!resultText) {
        return yield* new ClaudeCliParseError({
          message: 'Claude CLI returned no result',
          rawOutput: truncateForDisplay({
            text: result.stdout,
            maxChars: 5_000,
          }),
        })
      }

      // Strip markdown code blocks if JSON response format is expected
      const finalText =
        providerOptions.responseFormat.type === 'json'
          ? stripMarkdownCodeBlocks(resultText)
          : resultText

      const parts: Array<Response.PartEncoded> = [
        { type: 'text', text: finalText },
        {
          type: 'finish',
          reason: 'stop',
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
          },
        },
      ]

      return parts
    }).pipe(
      Effect.catchAllDefect(
        (defect) =>
          new ClaudeCliParseError({
            message: `Unexpected error: ${String(defect)}`,
            rawOutput: '',
            cause: defect,
          }),
      ),
      Effect.mapError(toAiError),
    )

  const streamText = (
    providerOptions: LanguageModel.ProviderOptions,
  ): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const promptText = promptToString({
          prompt: providerOptions.prompt,
          responseFormat: providerOptions.responseFormat,
        })

        const args = ['-p', '--output-format', 'stream-json', '--tools', '']

        if (options.model) {
          args.push('--model', options.model)
        }

        const command = Command.make('claude', ...args).pipe(Command.stdin('pipe'))

        const scope = yield* Scope.make()
        const startEmittedRef = yield* Ref.make(false)

        const process = yield* executor
          .start(command)
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(platformToAiError))

        // Write prompt to stdin
        yield* Stream.make(new TextEncoder().encode(promptText)).pipe(
          Stream.run(process.stdin),
          Effect.mapError(platformToAiError),
        )

        const textId = 'text-0'

        const outputStream: Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =
          process.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim().length > 0),
            Stream.mapError(platformToAiError),
            Stream.mapEffect((line) =>
              Effect.gen(function* () {
                const parsed = safeParseJson<{
                  type?: string
                  subtype?: string
                  result?: string
                  message?: { content?: string }
                  delta?: { text?: string }
                }>(line)

                if (!parsed) return [] as Response.StreamPartEncoded[]

                if (parsed.type === 'assistant' && parsed.message?.content) {
                  const content = parsed.message.content
                  if (typeof content === 'string') {
                    const startEmitted = yield* Ref.get(startEmittedRef)
                    const parts: Response.StreamPartEncoded[] = []
                    if (!startEmitted) {
                      parts.push({ type: 'text-start', id: textId })
                      yield* Ref.set(startEmittedRef, true)
                    }
                    parts.push({
                      type: 'text-delta',
                      id: textId,
                      delta: content,
                    })
                    return parts
                  }
                }

                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  const startEmitted = yield* Ref.get(startEmittedRef)
                  const parts: Response.StreamPartEncoded[] = []
                  if (!startEmitted) {
                    parts.push({ type: 'text-start', id: textId })
                    yield* Ref.set(startEmittedRef, true)
                  }
                  parts.push({
                    type: 'text-delta',
                    id: textId,
                    delta: parsed.delta.text,
                  })
                  return parts
                }

                if (parsed.type === 'result') {
                  if (parsed.subtype === 'success' && parsed.result) {
                    const startEmitted = yield* Ref.get(startEmittedRef)
                    const parts: Response.StreamPartEncoded[] = []
                    if (!startEmitted) {
                      parts.push({ type: 'text-start', id: textId })
                    }
                    parts.push({
                      type: 'text-delta',
                      id: textId,
                      delta: parsed.result,
                    })
                    parts.push({ type: 'text-end', id: textId })
                    return parts
                  }
                  if (parsed.subtype === 'error') {
                    // Classify the error based on the result message
                    const errorMessage = parsed.result ?? 'Unknown error'
                    return yield* toAiError(
                      classifyError({
                        exitCode: 1,
                        stdout: errorMessage,
                        stderr: '',
                        command: 'claude stream',
                      }),
                    )
                  }
                }

                return [] as Response.StreamPartEncoded[]
              }),
            ),
            Stream.flatMap((parts) => Stream.fromIterable(parts)),
            Stream.ensuring(Scope.close(scope, Exit.void)),
          )

        const finishPart: Response.StreamPartEncoded = {
          type: 'finish',
          reason: 'stop',
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
          },
        }

        return Stream.concat(outputStream, Stream.succeed(finishPart))
      }),
    )

  return yield* LanguageModel.make({ generateText, streamText })
})

/** Layer providing Claude CLI as the LanguageModel */
export const layer = (
  options: ClaudeCliOptions = {},
): Layer.Layer<LanguageModel.LanguageModel, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))
