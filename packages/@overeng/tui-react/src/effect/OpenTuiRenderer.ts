/**
 * OpenTUI Integration for Alternate Screen Mode
 *
 * Provides `progressive-visual-alternate` mode using OpenTUI for full-screen
 * terminal applications with built-in input handling.
 *
 * **Requirements:**
 * - Bun runtime (not Node.js)
 * - `@opentui/core` and `@opentui/react` packages
 *
 * Install:
 * ```bash
 * bun add @opentui/core @opentui/react
 * ```
 *
 * @example
 * ```typescript
 * import { useOpenTuiRenderer } from '@overeng/tui-react'
 * import { Effect } from 'effect'
 *
 * const runDashboard = Effect.gen(function* () {
 *   const renderer = yield* useOpenTuiRenderer({
 *     View: DashboardView,
 *     stateRef,
 *     onEvent: (event) => handleEvent(event),
 *   })
 *
 *   // Renderer runs until scope closes
 * }).pipe(Effect.scoped)
 * ```
 *
 * @module
 */

// =============================================================================
// TYPE WORKAROUND: Why we define OpenTUI types locally
// =============================================================================
//
// OpenTUI is an optional Bun-only peer dependency. We use local type definitions
// + `as unknown as` casts instead of importing types directly because:
//
// 1. This package must compile without @opentui/* installed (optional dep)
// 2. OpenTUI's .d.ts files use extensionless re-exports which don't resolve
//    with moduleResolution: "NodeNext" - see https://github.com/anomalyco/opentui/issues/504
//
// The pattern: opentui.d.ts provides ambient decls, this file defines local
// interfaces, and dynamic imports cast via `as unknown as LocalType`.
// =============================================================================

import type { Scope, SubscriptionRef } from 'effect'
import { Effect, PubSub, Runtime } from 'effect'
import type React from 'react'
import type { FC } from 'react'

import type { InputEvent } from './events.ts'
import { keyEvent, resizeEvent } from './events.ts'

// =============================================================================
// Error Types
// =============================================================================

/** Error when OpenTUI core module fails to import */
export class OpenTuiCoreImportError {
  readonly _tag = 'OpenTuiCoreImportError'
  constructor(readonly message: string) {}
}

/** Error when OpenTUI react module fails to import */
export class OpenTuiReactImportError {
  readonly _tag = 'OpenTuiReactImportError'
  constructor(readonly message: string) {}
}

/** Error when OpenTUI renderer fails to initialize */
export class OpenTuiRendererError {
  readonly _tag = 'OpenTuiRendererError'
  constructor(readonly message: string) {}
}

/** Error when OpenTUI is not available (wrong runtime) */
export class OpenTuiUnavailableError {
  readonly _tag = 'OpenTuiUnavailableError'
  constructor(readonly message: string) {}
}

/** Union of all OpenTUI-related errors */
export type OpenTuiError =
  | OpenTuiCoreImportError
  | OpenTuiReactImportError
  | OpenTuiRendererError
  | OpenTuiUnavailableError

/**
 * View props for OpenTUI renderer - passes stateRef directly.
 */
interface OpenTuiViewProps<S> {
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>
}

// =============================================================================
// Types
// =============================================================================

/**
 * OpenTUI renderer options.
 */
export interface OpenTuiRendererOptions<S> {
  /**
   * React component to render.
   */
  View: FC<OpenTuiViewProps<S>>

  /**
   * State reference to pass to the view.
   */
  stateRef: SubscriptionRef.SubscriptionRef<S>

  /**
   * PubSub to publish input events to.
   */
  eventPubSub?: PubSub.PubSub<InputEvent>

  /**
   * Whether to exit on Ctrl+C.
   * @default true
   */
  exitOnCtrlC?: boolean
}

/**
 * OpenTUI renderer instance.
 */
export interface OpenTuiRenderer {
  /**
   * Stop the renderer and restore the terminal.
   */
  readonly stop: Effect.Effect<void>
}

// =============================================================================
// OpenTUI Types (local definitions to avoid import issues across workspaces)
// =============================================================================

/** OpenTUI CLI renderer configuration */
interface OpenTuiCliRendererConfig {
  exitOnCtrlC?: boolean
}

/** OpenTUI CLI renderer instance (opaque) */
interface OpenTuiCliRenderer {
  // Opaque - we don't access internals directly
}

/** OpenTUI key event from keyboard handler */
interface OpenTuiKeyEvent {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  option: boolean
}

/** OpenTUI React root for rendering */
interface OpenTuiRoot {
  render(element: React.ReactNode): void
  unmount(): void
}

// =============================================================================
// OpenTUI Module Types (for dynamic import return values)
// =============================================================================

interface OpenTuiCoreModule {
  createCliRenderer: (options?: OpenTuiCliRendererConfig) => Promise<OpenTuiCliRenderer>
}

interface OpenTuiReactModule {
  createRoot: (renderer: OpenTuiCliRenderer) => OpenTuiRoot
  useKeyboard: (handler: (key: OpenTuiKeyEvent) => void, options?: { release?: boolean }) => void
  useOnResize: (handler: (width: number, height: number) => void) => void
  useTerminalDimensions: () => { width: number; height: number }
}

// =============================================================================
// Dynamic Import Helpers
// =============================================================================

const importOpenTuiCore = (): Effect.Effect<OpenTuiCoreModule, OpenTuiCoreImportError> =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import('@opentui/core')
      // Use unknown intermediate cast since actual module types may differ across workspaces
      return mod as unknown as OpenTuiCoreModule
    },
    catch: () =>
      new OpenTuiCoreImportError(
        'Failed to import @opentui/core. ' +
          'Install with: bun add @opentui/core @opentui/react\n' +
          'Note: OpenTUI requires Bun runtime (not Node.js)',
      ),
  })

const importOpenTuiReact = (): Effect.Effect<OpenTuiReactModule, OpenTuiReactImportError> =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import('@opentui/react')
      // Use unknown intermediate cast since actual module types may differ across workspaces
      return mod as unknown as OpenTuiReactModule
    },
    catch: () =>
      new OpenTuiReactImportError(
        'Failed to import @opentui/react. Install with: bun add @opentui/core @opentui/react',
      ),
  })

// =============================================================================
// Event Bridging
// =============================================================================

/**
 * Convert OpenTUI KeyEvent to our KeyEvent schema.
 */
const bridgeKeyEvent = (openTuiKey: OpenTuiKeyEvent): InputEvent =>
  keyEvent({
    key: openTuiKey.name,
    ctrl: openTuiKey.ctrl,
    alt: openTuiKey.meta || openTuiKey.option,
    shift: openTuiKey.shift,
    meta: openTuiKey.meta,
  })

/**
 * Convert OpenTUI resize to our ResizeEvent schema.
 */
const bridgeResizeEvent = ({ width, height }: { width: number; height: number }): InputEvent =>
  resizeEvent({ cols: width, rows: height })

// =============================================================================
// Renderer Implementation
// =============================================================================

/**
 * Create an OpenTUI-based renderer for alternate screen mode.
 *
 * This dynamically imports OpenTUI and sets up the renderer with event bridging.
 * The renderer is automatically cleaned up when the scope closes.
 *
 * @throws OpenTuiError if OpenTUI packages are not installed or Bun is not the runtime
 *
 * @example
 * ```typescript
 * const renderer = yield* useOpenTuiRenderer({
 *   View: MyDashboard,
 *   stateRef: myStateRef,
 *   eventPubSub: myEventPubSub,
 * })
 * ```
 */
export const useOpenTuiRenderer = <S>(
  options: OpenTuiRendererOptions<S>,
): Effect.Effect<OpenTuiRenderer, OpenTuiError, Scope.Scope> =>
  Effect.gen(function* () {
    const { View, stateRef, eventPubSub, exitOnCtrlC = true } = options

    // Check if we're running in Bun
    if (isOpenTuiAvailable() === false) {
      return yield* Effect.fail(
        new OpenTuiUnavailableError(
          'OpenTUI requires Bun runtime. ' +
            'Use inline modes (progressive-visual, final-visual) with Node.js.',
        ),
      )
    }

    // Dynamically import OpenTUI
    const [core, reactLib] = yield* Effect.all([importOpenTuiCore(), importOpenTuiReact()])

    // Create the CLI renderer
    const cliRenderer = yield* Effect.tryPromise({
      try: () => core.createCliRenderer({ exitOnCtrlC }),
      catch: (e) => new OpenTuiRendererError(`Failed to create OpenTUI renderer: ${e}`),
    })

    // Create React root
    const root = reactLib.createRoot(cliRenderer)

    // Import React for createElement
    const React = yield* Effect.promise(() => import('react'))

    const runtime = yield* Effect.runtime<never>()

    // Create wrapper component that bridges events
    const WrapperComponent: FC = () => {
      // Bridge keyboard events
      reactLib.useKeyboard(
        (key) => {
          if (eventPubSub !== undefined) {
            const event = bridgeKeyEvent(key)
            Runtime.runFork(runtime)(PubSub.publish(eventPubSub, event))
          }
        },
        { release: false },
      )

      // Bridge resize events
      reactLib.useOnResize((width, height) => {
        if (eventPubSub !== undefined) {
          const event = bridgeResizeEvent({ width, height })
          Runtime.runFork(runtime)(PubSub.publish(eventPubSub, event))
        }
      })

      // Render the user's view
      return React.createElement(View, { stateRef })
    }

    // Render the wrapper
    root.render(React.createElement(WrapperComponent))

    // Set up cleanup
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        root.unmount()
      }),
    )

    // Return the renderer interface
    return {
      stop: Effect.sync(() => {
        root.unmount()
      }),
    }
  })

/**
 * Check if OpenTUI is available in the current environment.
 *
 * @returns true if running in Bun and OpenTUI can potentially be imported
 */
export const isOpenTuiAvailable = (): boolean => {
  // Check for Bun runtime
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined'
}
