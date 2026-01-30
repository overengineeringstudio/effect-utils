/**
 * TerminalInput - Raw terminal input handling
 *
 * Provides utilities for reading raw keyboard input and parsing ANSI escape
 * sequences into structured KeyEvent objects.
 *
 * @example
 * ```typescript
 * import { TerminalInput, keyEvent } from '@overeng/tui-react'
 * import { Effect, PubSub, Stream } from 'effect'
 *
 * // Create input handler
 * const input = yield* TerminalInput.create()
 *
 * // Read events
 * yield* input.events.pipe(
 *   Stream.runForEach(event => {
 *     if (event._tag === 'Event.Key' && event.key === 'q') {
 *       return Effect.interrupt
 *     }
 *     return Effect.log(`Key: ${event.key}`)
 *   }),
 * )
 * ```
 */

import type { Readable } from 'node:stream'

import type { Scope } from 'effect'
import { Effect, PubSub, Stream } from 'effect'

import { type KeyEvent, keyEvent, resizeEvent, type InputEvent } from './events.ts'

// =============================================================================
// ANSI Key Parsing
// =============================================================================

/**
 * Parse raw terminal input into KeyEvent objects.
 *
 * This handles:
 * - Single printable characters
 * - Control characters (Ctrl+A through Ctrl+Z)
 * - ANSI escape sequences (arrow keys, function keys, etc.)
 */
export const parseKeyInput = (data: Buffer): KeyEvent[] => {
  const events: KeyEvent[] = []
  let i = 0

  while (i < data.length) {
    const byte = data[i]!

    // ESC sequence
    if (byte === 0x1b) {
      // Check for CSI sequence (ESC [)
      if (i + 1 < data.length && data[i + 1] === 0x5b) {
        const result = parseCSISequence({ data, start: i + 2 })
        if (result) {
          events.push(result.event)
          i = result.nextIndex
          continue
        }
      }

      // Check for SS3 sequence (ESC O) - function keys
      if (i + 1 < data.length && data[i + 1] === 0x4f) {
        const result = parseSS3Sequence({ data, start: i + 2 })
        if (result) {
          events.push(result.event)
          i = result.nextIndex
          continue
        }
      }

      // Alt + key (ESC followed by printable char)
      if (i + 1 < data.length && data[i + 1]! >= 0x20 && data[i + 1]! < 0x7f) {
        const char = String.fromCharCode(data[i + 1]!)
        events.push(keyEvent({ key: char, alt: true }))
        i += 2
        continue
      }

      // Just ESC
      events.push(keyEvent({ key: 'escape' }))
      i++
      continue
    }

    // Control characters (Ctrl+A through Ctrl+Z)
    if (byte < 0x20) {
      const ctrlKey = parseControlCharacter(byte)
      if (ctrlKey) {
        events.push(ctrlKey)
        i++
        continue
      }
    }

    // Delete key
    if (byte === 0x7f) {
      events.push(keyEvent({ key: 'backspace' }))
      i++
      continue
    }

    // Regular printable character
    if (byte >= 0x20 && byte < 0x7f) {
      const char = String.fromCharCode(byte)
      events.push(keyEvent({ key: char }))
      i++
      continue
    }

    // UTF-8 multi-byte character
    if (byte >= 0x80) {
      const result = parseUTF8Char({ data, start: i })
      if (result) {
        events.push(keyEvent({ key: result.char }))
        i = result.nextIndex
        continue
      }
    }

    // Unknown byte, skip
    i++
  }

  return events
}

/**
 * Parse CSI (Control Sequence Introducer) sequences.
 * Format: ESC [ <params> <char>
 */
const parseCSISequence = ({
  data,
  start,
}: {
  data: Buffer
  start: number
}): { event: KeyEvent; nextIndex: number } | null => {
  let i = start
  let params = ''

  // Read parameter bytes (digits and semicolons)
  while (i < data.length && ((data[i]! >= 0x30 && data[i]! <= 0x3f) || data[i] === 0x3b)) {
    params += String.fromCharCode(data[i]!)
    i++
  }

  // Final byte
  if (i >= data.length) return null

  const finalByte = data[i]!
  i++

  // Parse modifiers from params
  const modifiers = parseCSIModifiers(params)

  // Map final byte to key
  switch (finalByte) {
    case 0x41: // A - Up
      return { event: keyEvent({ key: 'up', ...modifiers }), nextIndex: i }
    case 0x42: // B - Down
      return { event: keyEvent({ key: 'down', ...modifiers }), nextIndex: i }
    case 0x43: // C - Right
      return { event: keyEvent({ key: 'right', ...modifiers }), nextIndex: i }
    case 0x44: // D - Left
      return { event: keyEvent({ key: 'left', ...modifiers }), nextIndex: i }
    case 0x45: // E - Begin (keypad 5)
      return { event: keyEvent({ key: 'begin', ...modifiers }), nextIndex: i }
    case 0x46: // F - End
      return { event: keyEvent({ key: 'end', ...modifiers }), nextIndex: i }
    case 0x48: // H - Home
      return { event: keyEvent({ key: 'home', ...modifiers }), nextIndex: i }
    case 0x50: // P - F1
      return { event: keyEvent({ key: 'f1', ...modifiers }), nextIndex: i }
    case 0x51: // Q - F2
      return { event: keyEvent({ key: 'f2', ...modifiers }), nextIndex: i }
    case 0x52: // R - F3
      return { event: keyEvent({ key: 'f3', ...modifiers }), nextIndex: i }
    case 0x53: // S - F4
      return { event: keyEvent({ key: 'f4', ...modifiers }), nextIndex: i }
    case 0x5a: // Z - Shift+Tab
      return { event: keyEvent({ key: 'tab', shift: true }), nextIndex: i }
    case 0x7e: // ~ - Extended keys (based on params)
      return parseExtendedKey({ params, modifiers, nextIndex: i })
    default:
      return null
  }
}

/**
 * Parse extended key codes (CSI <num> ~).
 */
const parseExtendedKey = ({
  params,
  modifiers,
  nextIndex,
}: {
  params: string
  modifiers: ReturnType<typeof parseCSIModifiers>
  nextIndex: number
}): { event: KeyEvent; nextIndex: number } | null => {
  const parts = params.split(';')
  const keyCode = parseInt(parts[0] ?? '', 10)

  switch (keyCode) {
    case 1: // Home (alternate)
      return { event: keyEvent({ key: 'home', ...modifiers }), nextIndex }
    case 2: // Insert
      return { event: keyEvent({ key: 'insert', ...modifiers }), nextIndex }
    case 3: // Delete
      return { event: keyEvent({ key: 'delete', ...modifiers }), nextIndex }
    case 4: // End (alternate)
      return { event: keyEvent({ key: 'end', ...modifiers }), nextIndex }
    case 5: // Page Up
      return { event: keyEvent({ key: 'pageup', ...modifiers }), nextIndex }
    case 6: // Page Down
      return { event: keyEvent({ key: 'pagedown', ...modifiers }), nextIndex }
    case 7: // Home
      return { event: keyEvent({ key: 'home', ...modifiers }), nextIndex }
    case 8: // End
      return { event: keyEvent({ key: 'end', ...modifiers }), nextIndex }
    case 11: // F1
      return { event: keyEvent({ key: 'f1', ...modifiers }), nextIndex }
    case 12: // F2
      return { event: keyEvent({ key: 'f2', ...modifiers }), nextIndex }
    case 13: // F3
      return { event: keyEvent({ key: 'f3', ...modifiers }), nextIndex }
    case 14: // F4
      return { event: keyEvent({ key: 'f4', ...modifiers }), nextIndex }
    case 15: // F5
      return { event: keyEvent({ key: 'f5', ...modifiers }), nextIndex }
    case 17: // F6
      return { event: keyEvent({ key: 'f6', ...modifiers }), nextIndex }
    case 18: // F7
      return { event: keyEvent({ key: 'f7', ...modifiers }), nextIndex }
    case 19: // F8
      return { event: keyEvent({ key: 'f8', ...modifiers }), nextIndex }
    case 20: // F9
      return { event: keyEvent({ key: 'f9', ...modifiers }), nextIndex }
    case 21: // F10
      return { event: keyEvent({ key: 'f10', ...modifiers }), nextIndex }
    case 23: // F11
      return { event: keyEvent({ key: 'f11', ...modifiers }), nextIndex }
    case 24: // F12
      return { event: keyEvent({ key: 'f12', ...modifiers }), nextIndex }
    default:
      return null
  }
}

/**
 * Parse SS3 (Single Shift 3) sequences.
 * Format: ESC O <char>
 * Used for function keys and keypad on some terminals.
 */
const parseSS3Sequence = ({
  data,
  start,
}: {
  data: Buffer
  start: number
}): { event: KeyEvent; nextIndex: number } | null => {
  if (start >= data.length) return null

  const byte = data[start]!
  const nextIndex = start + 1

  switch (byte) {
    case 0x41: // A - Up
      return { event: keyEvent({ key: 'up' }), nextIndex }
    case 0x42: // B - Down
      return { event: keyEvent({ key: 'down' }), nextIndex }
    case 0x43: // C - Right
      return { event: keyEvent({ key: 'right' }), nextIndex }
    case 0x44: // D - Left
      return { event: keyEvent({ key: 'left' }), nextIndex }
    case 0x46: // F - End
      return { event: keyEvent({ key: 'end' }), nextIndex }
    case 0x48: // H - Home
      return { event: keyEvent({ key: 'home' }), nextIndex }
    case 0x50: // P - F1
      return { event: keyEvent({ key: 'f1' }), nextIndex }
    case 0x51: // Q - F2
      return { event: keyEvent({ key: 'f2' }), nextIndex }
    case 0x52: // R - F3
      return { event: keyEvent({ key: 'f3' }), nextIndex }
    case 0x53: // S - F4
      return { event: keyEvent({ key: 'f4' }), nextIndex }
    default:
      return null
  }
}

/**
 * Parse CSI modifier parameters.
 * Format: ...;modifier where modifier encodes Shift, Alt, Ctrl, Meta.
 */
const parseCSIModifiers = (
  params: string,
): { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } => {
  const parts = params.split(';')
  if (parts.length < 2) return {}

  const modifier = parseInt(parts[parts.length - 1]!, 10)
  if (isNaN(modifier)) return {}

  // Modifier encoding: 1 + (Shift ? 1 : 0) + (Alt ? 2 : 0) + (Ctrl ? 4 : 0) + (Meta ? 8 : 0)
  const adjusted = modifier - 1
  return {
    shift: (adjusted & 1) !== 0,
    alt: (adjusted & 2) !== 0,
    ctrl: (adjusted & 4) !== 0,
    meta: (adjusted & 8) !== 0,
  }
}

/**
 * Parse control characters (Ctrl+A through Ctrl+Z and special keys).
 */
const parseControlCharacter = (byte: number): KeyEvent | null => {
  switch (byte) {
    case 0x00: // Ctrl+Space or Ctrl+@
      return keyEvent({ key: 'space', ctrl: true })
    case 0x01: // Ctrl+A
      return keyEvent({ key: 'a', ctrl: true })
    case 0x02: // Ctrl+B
      return keyEvent({ key: 'b', ctrl: true })
    case 0x03: // Ctrl+C
      return keyEvent({ key: 'c', ctrl: true })
    case 0x04: // Ctrl+D
      return keyEvent({ key: 'd', ctrl: true })
    case 0x05: // Ctrl+E
      return keyEvent({ key: 'e', ctrl: true })
    case 0x06: // Ctrl+F
      return keyEvent({ key: 'f', ctrl: true })
    case 0x07: // Ctrl+G (Bell)
      return keyEvent({ key: 'g', ctrl: true })
    case 0x08: // Ctrl+H (Backspace on some terminals)
      return keyEvent({ key: 'backspace' })
    case 0x09: // Tab
      return keyEvent({ key: 'tab' })
    case 0x0a: // Ctrl+J (Line Feed)
      return keyEvent({ key: 'j', ctrl: true })
    case 0x0b: // Ctrl+K
      return keyEvent({ key: 'k', ctrl: true })
    case 0x0c: // Ctrl+L (Form Feed)
      return keyEvent({ key: 'l', ctrl: true })
    case 0x0d: // Enter/Return
      return keyEvent({ key: 'return' })
    case 0x0e: // Ctrl+N
      return keyEvent({ key: 'n', ctrl: true })
    case 0x0f: // Ctrl+O
      return keyEvent({ key: 'o', ctrl: true })
    case 0x10: // Ctrl+P
      return keyEvent({ key: 'p', ctrl: true })
    case 0x11: // Ctrl+Q
      return keyEvent({ key: 'q', ctrl: true })
    case 0x12: // Ctrl+R
      return keyEvent({ key: 'r', ctrl: true })
    case 0x13: // Ctrl+S
      return keyEvent({ key: 's', ctrl: true })
    case 0x14: // Ctrl+T
      return keyEvent({ key: 't', ctrl: true })
    case 0x15: // Ctrl+U
      return keyEvent({ key: 'u', ctrl: true })
    case 0x16: // Ctrl+V
      return keyEvent({ key: 'v', ctrl: true })
    case 0x17: // Ctrl+W
      return keyEvent({ key: 'w', ctrl: true })
    case 0x18: // Ctrl+X
      return keyEvent({ key: 'x', ctrl: true })
    case 0x19: // Ctrl+Y
      return keyEvent({ key: 'y', ctrl: true })
    case 0x1a: // Ctrl+Z
      return keyEvent({ key: 'z', ctrl: true })
    case 0x1b: // Escape
      return keyEvent({ key: 'escape' })
    case 0x1c: // Ctrl+\
      return keyEvent({ key: '\\', ctrl: true })
    case 0x1d: // Ctrl+]
      return keyEvent({ key: ']', ctrl: true })
    case 0x1e: // Ctrl+^
      return keyEvent({ key: '^', ctrl: true })
    case 0x1f: // Ctrl+_
      return keyEvent({ key: '_', ctrl: true })
    default:
      return null
  }
}

/**
 * Parse UTF-8 multi-byte character.
 */
const parseUTF8Char = ({
  data,
  start,
}: {
  data: Buffer
  start: number
}): { char: string; nextIndex: number } | null => {
  const firstByte = data[start]!
  let numBytes: number

  // Determine number of bytes in UTF-8 sequence
  if ((firstByte & 0xe0) === 0xc0) {
    numBytes = 2
  } else if ((firstByte & 0xf0) === 0xe0) {
    numBytes = 3
  } else if ((firstByte & 0xf8) === 0xf0) {
    numBytes = 4
  } else {
    return null
  }

  // Check if we have enough bytes
  if (start + numBytes > data.length) return null

  // Extract the character
  try {
    const char = data.toString('utf8', start, start + numBytes)
    return { char, nextIndex: start + numBytes }
  } catch {
    return null
  }
}

// =============================================================================
// Terminal Input Service
// =============================================================================

/**
 * Options for creating a TerminalInput.
 */
export interface TerminalInputOptions {
  /**
   * Input stream to read from.
   * @default process.stdin
   */
  input?: Readable

  /**
   * Whether to enable raw mode.
   * @default true
   */
  rawMode?: boolean

  /**
   * Whether to handle Ctrl+C (SIGINT).
   * If true, Ctrl+C will publish an event instead of killing the process.
   * @default false
   */
  handleCtrlC?: boolean

  /**
   * Whether to listen for terminal resize events (SIGWINCH).
   * @default true
   */
  handleResize?: boolean

  /**
   * Output stream for getting terminal dimensions.
   * @default process.stdout
   */
  output?: NodeJS.WriteStream
}

/**
 * Terminal input handler.
 */
export interface TerminalInput {
  /**
   * Stream of input events.
   */
  readonly events: Stream.Stream<InputEvent>

  /**
   * PubSub for publishing events.
   */
  readonly pubsub: PubSub.PubSub<InputEvent>

  /**
   * Whether raw mode is enabled.
   */
  readonly isRawMode: boolean
}

/**
 * Create a terminal input handler.
 *
 * This sets up raw mode on the terminal (if TTY) and reads keyboard input,
 * parsing it into structured KeyEvent objects.
 *
 * @example
 * ```typescript
 * const input = yield* createTerminalInput()
 *
 * yield* input.events.pipe(
 *   Stream.runForEach(event => {
 *     console.log('Event:', event)
 *   }),
 *   Effect.forkScoped,
 * )
 * ```
 */
export const createTerminalInput = (
  options: TerminalInputOptions = {},
): Effect.Effect<TerminalInput, never, Scope.Scope> =>
  Effect.gen(function* () {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    const rawMode = options.rawMode ?? true
    const handleCtrlC = options.handleCtrlC ?? false
    const handleResize = options.handleResize ?? true

    // Create event PubSub
    const pubsub = yield* PubSub.unbounded<InputEvent>()

    // Track if raw mode was set
    let wasRawMode = false
    const isTTY = 'isTTY' in input && input.isTTY
    const setRawMode = 'setRawMode' in input ? (input.setRawMode as (mode: boolean) => void) : null

    // Enable raw mode if TTY
    if (rawMode && isTTY && setRawMode) {
      wasRawMode = true
      setRawMode(true)

      // Restore raw mode on cleanup
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          setRawMode(false)
        }),
      )
    }

    // Set up data handler
    const dataHandler = (data: Buffer) => {
      const events = parseKeyInput(data)
      for (const event of events) {
        // Handle Ctrl+C specially if not handling it ourselves
        if (event.ctrl && event.key === 'c' && !handleCtrlC) {
          process.exit(130) // Standard exit code for Ctrl+C
        }

        // Publish event - fire and forget for the sync callback
        Effect.runFork(PubSub.publish(pubsub, event))
      }
    }

    // Start listening
    input.on('data', dataHandler)

    // Resume input stream (in case it was paused)
    if ('resume' in input && typeof input.resume === 'function') {
      input.resume()
    }

    // Cleanup listener on scope close
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        input.off('data', dataHandler)
        if ('pause' in input && typeof input.pause === 'function') {
          input.pause()
        }
      }),
    )

    // Set up resize handler if enabled
    if (handleResize && output.isTTY) {
      const resizeHandler = () => {
        const cols = output.columns ?? 80
        const rows = output.rows ?? 24
        Effect.runFork(PubSub.publish(pubsub, resizeEvent({ cols, rows })))
      }

      // Listen for SIGWINCH (terminal resize signal)
      process.on('SIGWINCH', resizeHandler)

      // Cleanup on scope close
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off('SIGWINCH', resizeHandler)
        }),
      )

      // Publish initial resize event with current dimensions
      const initialCols = output.columns ?? 80
      const initialRows = output.rows ?? 24
      yield* PubSub.publish(pubsub, resizeEvent({ cols: initialCols, rows: initialRows }))
    }

    // Create events stream from PubSub
    const events = Stream.fromPubSub(pubsub)

    return {
      events,
      pubsub,
      isRawMode: wasRawMode,
    }
  })

/**
 * Check if the terminal supports raw mode input.
 */
export const supportsRawMode = (): boolean => {
  return process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function'
}

// =============================================================================
// Resize Handling
// =============================================================================

/**
 * Terminal resize handler.
 */
export interface TerminalResize {
  /**
   * Stream of resize events.
   */
  readonly events: Stream.Stream<{ cols: number; rows: number }>

  /**
   * Get the current terminal dimensions.
   */
  readonly getDimensions: () => { cols: number; rows: number }
}

/**
 * Create a terminal resize handler.
 *
 * This listens for SIGWINCH signals and publishes resize events.
 *
 * @example
 * ```typescript
 * const resize = yield* createTerminalResize()
 *
 * // Get initial dimensions
 * console.log('Dimensions:', resize.getDimensions())
 *
 * // Listen for resize events
 * yield* resize.events.pipe(
 *   Stream.runForEach(({ cols, rows }) => {
 *     console.log(`Resized to ${cols}x${rows}`)
 *   }),
 *   Effect.forkScoped,
 * )
 * ```
 */
export const createTerminalResize = (
  output: NodeJS.WriteStream = process.stdout,
): Effect.Effect<TerminalResize, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Create PubSub for resize events
    const pubsub = yield* PubSub.unbounded<{ cols: number; rows: number }>()

    // Get dimensions helper
    const getDimensions = (): { cols: number; rows: number } => ({
      cols: output.columns ?? 80,
      rows: output.rows ?? 24,
    })

    if (output.isTTY) {
      // Set up resize handler
      const resizeHandler = () => {
        const dims = getDimensions()
        Effect.runFork(PubSub.publish(pubsub, dims))
      }

      // Listen for SIGWINCH
      process.on('SIGWINCH', resizeHandler)

      // Cleanup on scope close
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off('SIGWINCH', resizeHandler)
        }),
      )
    }

    // Create events stream
    const events = Stream.fromPubSub(pubsub)

    return {
      events,
      getDimensions,
    }
  })

/**
 * Get the current terminal dimensions.
 *
 * Returns default dimensions (80x24) if not a TTY.
 *
 * @example
 * ```typescript
 * const { cols, rows } = getTerminalDimensions()
 * console.log(`Terminal is ${cols}x${rows}`)
 * ```
 */
export const getTerminalDimensions = (
  output: NodeJS.WriteStream = process.stdout,
): { cols: number; rows: number } => ({
  cols: output.columns ?? 80,
  rows: output.rows ?? 24,
})

/**
 * Check if the output is a TTY (supports resize events).
 */
export const isOutputTTY = (output: NodeJS.WriteStream = process.stdout): boolean => {
  return output.isTTY === true
}
