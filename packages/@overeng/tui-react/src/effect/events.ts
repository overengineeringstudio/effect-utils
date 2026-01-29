/**
 * Event Schemas for Bidirectional Communication
 *
 * Defines schemas for input events (keyboard, resize) that flow from
 * renderer to command for interactive TUI applications.
 *
 * @example
 * ```typescript
 * import { KeyEvent, ResizeEvent, InputEvent } from '@overeng/tui-react'
 * import { PubSub, Effect } from 'effect'
 *
 * const events = yield* PubSub.unbounded<InputEvent>()
 *
 * // Publish keyboard event
 * yield* PubSub.publish(events, { _tag: 'Event.Key', key: 'q', ctrl: false })
 *
 * // Subscribe to events
 * yield* PubSub.subscribe(events).pipe(
 *   Stream.runForEach(event => handleEvent(event))
 * )
 * ```
 */

import { Schema } from 'effect'

// =============================================================================
// Key Event
// =============================================================================

/**
 * Keyboard event schema.
 *
 * Represents a key press with optional modifiers.
 *
 * @example
 * ```typescript
 * const event: KeyEvent = {
 *   _tag: 'Event.Key',
 *   key: 'a',
 *   ctrl: false,
 *   alt: false,
 *   shift: false,
 * }
 *
 * // Ctrl+C
 * const ctrlC: KeyEvent = {
 *   _tag: 'Event.Key',
 *   key: 'c',
 *   ctrl: true,
 * }
 *
 * // Special keys
 * const escape: KeyEvent = { _tag: 'Event.Key', key: 'escape' }
 * const enter: KeyEvent = { _tag: 'Event.Key', key: 'return' }
 * const up: KeyEvent = { _tag: 'Event.Key', key: 'up' }
 * ```
 */
export const KeyEvent = Schema.TaggedStruct('Event.Key', {
  /**
   * The key that was pressed.
   *
   * For printable characters, this is the character itself ('a', 'b', '1', etc.)
   * For special keys, this is a descriptive name:
   * - Arrow keys: 'up', 'down', 'left', 'right'
   * - Navigation: 'home', 'end', 'pageup', 'pagedown'
   * - Editing: 'backspace', 'delete', 'tab'
   * - Control: 'escape', 'return', 'space'
   * - Function keys: 'f1' through 'f12'
   */
  key: Schema.String,

  /**
   * Whether the Ctrl key was held.
   * @default false
   */
  ctrl: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  /**
   * Whether the Alt/Option key was held.
   * @default false
   */
  alt: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  /**
   * Whether the Shift key was held.
   * @default false
   */
  shift: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  /**
   * Whether the Meta/Command key was held (macOS).
   * @default false
   */
  meta: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})

/**
 * Type for KeyEvent
 */
export type KeyEvent = Schema.Schema.Type<typeof KeyEvent>

/**
 * Encoded type for KeyEvent (for JSON)
 */
export type KeyEventEncoded = Schema.Schema.Encoded<typeof KeyEvent>

// =============================================================================
// Resize Event
// =============================================================================

/**
 * Terminal resize event schema.
 *
 * Published when the terminal window is resized.
 *
 * @example
 * ```typescript
 * const event: ResizeEvent = {
 *   _tag: 'Event.Resize',
 *   cols: 120,
 *   rows: 40,
 * }
 * ```
 */
export const ResizeEvent = Schema.TaggedStruct('Event.Resize', {
  /**
   * Number of columns (width in characters)
   */
  cols: Schema.Number,

  /**
   * Number of rows (height in lines)
   */
  rows: Schema.Number,
})

/**
 * Type for ResizeEvent
 */
export type ResizeEvent = Schema.Schema.Type<typeof ResizeEvent>

/**
 * Encoded type for ResizeEvent (for JSON)
 */
export type ResizeEventEncoded = Schema.Schema.Encoded<typeof ResizeEvent>

// =============================================================================
// Focus Event
// =============================================================================

/**
 * Terminal focus event schema.
 *
 * Published when the terminal gains or loses focus.
 * Note: Not all terminals support focus events.
 *
 * @example
 * ```typescript
 * const focused: FocusEvent = { _tag: 'Event.Focus', focused: true }
 * const blurred: FocusEvent = { _tag: 'Event.Focus', focused: false }
 * ```
 */
export const FocusEvent = Schema.TaggedStruct('Event.Focus', {
  /**
   * Whether the terminal is focused
   */
  focused: Schema.Boolean,
})

/**
 * Type for FocusEvent
 */
export type FocusEvent = Schema.Schema.Type<typeof FocusEvent>

/**
 * Encoded type for FocusEvent (for JSON)
 */
export type FocusEventEncoded = Schema.Schema.Encoded<typeof FocusEvent>

// =============================================================================
// Mouse Event (for future use)
// =============================================================================

/**
 * Mouse button identifier
 */
export const MouseButton = Schema.Literal('left', 'middle', 'right', 'wheelUp', 'wheelDown')

/**
 * Type for MouseButton
 */
export type MouseButton = Schema.Schema.Type<typeof MouseButton>

/**
 * Mouse event schema.
 *
 * Published for mouse interactions when mouse tracking is enabled.
 * Note: Mouse support varies by terminal.
 *
 * @example
 * ```typescript
 * const click: MouseEvent = {
 *   _tag: 'Event.Mouse',
 *   action: 'press',
 *   button: 'left',
 *   x: 10,
 *   y: 5,
 * }
 * ```
 */
export const MouseEvent = Schema.TaggedStruct('Event.Mouse', {
  /**
   * The type of mouse action
   */
  action: Schema.Literal('press', 'release', 'move'),

  /**
   * The button involved (if any)
   */
  button: Schema.optional(MouseButton),

  /**
   * X coordinate (column, 0-based)
   */
  x: Schema.Number,

  /**
   * Y coordinate (row, 0-based)
   */
  y: Schema.Number,

  /**
   * Whether Ctrl was held
   */
  ctrl: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  /**
   * Whether Alt was held
   */
  alt: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  /**
   * Whether Shift was held
   */
  shift: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})

/**
 * Type for MouseEvent
 */
export type MouseEvent = Schema.Schema.Type<typeof MouseEvent>

/**
 * Encoded type for MouseEvent (for JSON)
 */
export type MouseEventEncoded = Schema.Schema.Encoded<typeof MouseEvent>

// =============================================================================
// Input Event Union
// =============================================================================

/**
 * Union of all input events.
 *
 * Use this type for general event handling.
 *
 * @example
 * ```typescript
 * import { PubSub, Stream, Match } from 'effect'
 *
 * const handleEvent = (event: InputEvent) =>
 *   Match.value(event).pipe(
 *     Match.tag('Event.Key', ({ key, ctrl }) => {
 *       if (ctrl && key === 'c') return Effect.interrupt
 *       // Handle other keys
 *     }),
 *     Match.tag('Event.Resize', ({ cols, rows }) => {
 *       // Update viewport
 *     }),
 *     Match.exhaustive,
 *   )
 * ```
 */
export const InputEvent = Schema.Union(KeyEvent, ResizeEvent, FocusEvent, MouseEvent)

/**
 * Type for InputEvent
 */
export type InputEvent = Schema.Schema.Type<typeof InputEvent>

/**
 * Encoded type for InputEvent (for JSON)
 */
export type InputEventEncoded = Schema.Schema.Encoded<typeof InputEvent>

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a key event.
 *
 * @example
 * ```typescript
 * const event = keyEvent({ key: 'a' })
 * const ctrlC = keyEvent({ key: 'c', ctrl: true })
 * const shiftTab = keyEvent({ key: 'tab', shift: true })
 * ```
 */
export const keyEvent = ({
  key,
  ctrl,
  alt,
  shift,
  meta,
}: {
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}): KeyEvent => ({
  _tag: 'Event.Key',
  key,
  ctrl: ctrl ?? false,
  alt: alt ?? false,
  shift: shift ?? false,
  meta: meta ?? false,
})

/**
 * Create a resize event.
 *
 * @example
 * ```typescript
 * const event = resizeEvent({ cols: 120, rows: 40 })
 * ```
 */
export const resizeEvent = ({ cols, rows }: { cols: number; rows: number }): ResizeEvent => ({
  _tag: 'Event.Resize',
  cols,
  rows,
})

/**
 * Create a focus event.
 *
 * @example
 * ```typescript
 * const focused = focusEvent(true)
 * const blurred = focusEvent(false)
 * ```
 */
export const focusEvent = (focused: boolean): FocusEvent => ({
  _tag: 'Event.Focus',
  focused,
})

/**
 * Create a mouse event.
 *
 * @example
 * ```typescript
 * const click = mouseEvent({ action: 'press', x: 10, y: 5, button: 'left' })
 * const move = mouseEvent({ action: 'move', x: 15, y: 8 })
 * ```
 */
export const mouseEvent = ({
  action,
  x,
  y,
  button,
  ctrl,
  alt,
  shift,
}: {
  action: 'press' | 'release' | 'move'
  x: number
  y: number
  button?: MouseButton
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}): MouseEvent => ({
  _tag: 'Event.Mouse',
  action,
  x,
  y,
  button,
  ctrl: ctrl ?? false,
  alt: alt ?? false,
  shift: shift ?? false,
})

// =============================================================================
// Event Matchers
// =============================================================================

/**
 * Check if an event is a key event.
 */
export const isKeyEvent = (event: InputEvent): event is KeyEvent => event._tag === 'Event.Key'

/**
 * Check if an event is a resize event.
 */
export const isResizeEvent = (event: InputEvent): event is ResizeEvent =>
  event._tag === 'Event.Resize'

/**
 * Check if an event is a focus event.
 */
export const isFocusEvent = (event: InputEvent): event is FocusEvent => event._tag === 'Event.Focus'

/**
 * Check if an event is a mouse event.
 */
export const isMouseEvent = (event: InputEvent): event is MouseEvent => event._tag === 'Event.Mouse'

/**
 * Check if a key event matches a specific key (case-insensitive).
 *
 * @example
 * ```typescript
 * if (isKeyEvent(event) && isKey({ event, key: 'q' })) {
 *   yield* Effect.interrupt
 * }
 * ```
 */
export const isKey = ({ event, key }: { event: KeyEvent; key: string }): boolean =>
  event.key.toLowerCase() === key.toLowerCase()

/**
 * Check if a key event is Ctrl+C.
 */
export const isCtrlC = (event: KeyEvent): boolean => event.ctrl && isKey({ event, key: 'c' })

/**
 * Check if a key event is Ctrl+D.
 */
export const isCtrlD = (event: KeyEvent): boolean => event.ctrl && isKey({ event, key: 'd' })

/**
 * Check if a key event is Escape.
 */
export const isEscape = (event: KeyEvent): boolean => isKey({ event, key: 'escape' })

/**
 * Check if a key event is Enter/Return.
 */
export const isEnter = (event: KeyEvent): boolean =>
  isKey({ event, key: 'return' }) || isKey({ event, key: 'enter' })

/**
 * Check if a key event is an arrow key.
 */
export const isArrowKey = (
  event: KeyEvent,
): event is KeyEvent & { key: 'up' | 'down' | 'left' | 'right' } =>
  ['up', 'down', 'left', 'right'].includes(event.key.toLowerCase())
