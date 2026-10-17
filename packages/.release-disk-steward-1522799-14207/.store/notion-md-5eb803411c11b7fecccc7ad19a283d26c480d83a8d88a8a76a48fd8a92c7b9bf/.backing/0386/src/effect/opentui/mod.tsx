/**
 * OpenTUI Integration Module
 *
 * Components and hooks for building full-screen terminal applications
 * using OpenTUI's alternate screen mode.
 *
 * **Requirements:**
 * - Bun runtime (not Node.js)
 * - `@opentui/core` and `@opentui/react` packages
 *
 * **Installation:**
 * ```bash
 * bun add @opentui/core @opentui/react
 * ```
 *
 * **Usage:**
 * ```tsx
 * // dashboard.tsx
 * /** @jsxImportSource @opentui/react *\/
 *
 * import { createCliRenderer } from '@opentui/core'
 * import { createRoot, useKeyboard, useOnResize } from '@opentui/react'
 * import { OBox, OText, OSpinner, useOState, createKeyboardHandler, createResizeHandler } from '@overeng/tui-react/opentui'
 *
 * function Dashboard({ stateRef, eventPubSub }) {
 *   const state = useOState(stateRef)
 *
 *   // Bridge keyboard events to Effect
 *   useKeyboard(createKeyboardHandler(eventPubSub))
 *   useOnResize(createResizeHandler(eventPubSub))
 *
 *   return (
 *     <OBox flexDirection="column" padding={1} border>
 *       <OText bold color="cyan">Dashboard</OText>
 *       <OText>Status: {state.status}</OText>
 *       {state.loading && <OSpinner color="yellow" />}
 *     </OBox>
 *   )
 * }
 *
 * // Entry point
 * const renderer = await createCliRenderer({ exitOnCtrlC: true })
 * createRoot(renderer).render(<Dashboard stateRef={stateRef} eventPubSub={eventPubSub} />)
 * ```
 *
 * @module
 */

// Components
export {
  OBox,
  OText,
  OSpinner,
  OScrollBox,
  OInput,
  type OBoxProps,
  type OTextProps,
  type OSpinnerProps,
  type OScrollBoxProps,
  type OInputProps,
  type Color,
  type FlexDirection,
  type FlexAlign,
  type FlexJustify,
} from './components.tsx'

// Hooks
export {
  useOState,
  useODispatch,
  useOKeyboard,
  createKeyboardHandler,
  createResizeHandler,
  type UseOKeyboardOptions,
} from './hooks.tsx'

// Re-export core OpenTUI types for convenience
export {
  isOpenTuiAvailable,
  useOpenTuiRenderer,
  type OpenTuiRendererOptions,
} from '../OpenTuiRenderer.ts'

// Re-export event types
export {
  type InputEvent,
  type KeyEvent as KeyEventType,
  type ResizeEvent as ResizeEventType,
  keyEvent,
  resizeEvent,
  isKeyEvent,
  isCtrlC,
  isEscape,
  isEnter,
  isArrowKey,
} from '../events.ts'
