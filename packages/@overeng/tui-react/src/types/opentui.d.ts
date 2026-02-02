/**
 * Type declarations for optional OpenTUI dependencies.
 *
 * OpenTUI is an optional dependency that only works in Bun environments.
 * These declarations allow TypeScript to compile without the packages installed.
 *
 * When OpenTUI is installed, these types will be overridden by the actual package types.
 *
 * Updated for OpenTUI 0.1.74 API.
 */

// =============================================================================
// WHY THIS FILE EXISTS
// =============================================================================
//
// Ambient declarations for optional @opentui/* peer dependencies. Required because:
// 1. This package must compile without @opentui/* installed (optional dep)
// 2. OpenTUI's .d.ts files use extensionless re-exports which don't resolve
//    with moduleResolution: "NodeNext" - see https://github.com/anomalyco/opentui/issues/504
//
// When OpenTUI API changes: update this file, OpenTuiRenderer.ts local interfaces,
// and src/effect/opentui/hooks.tsx.
// =============================================================================

declare module '@opentui/core' {
  /** Configuration options for creating a CLI renderer instance. */
  export interface CliRendererConfig {
    exitOnCtrlC?: boolean
  }

  /** Opaque handle to an OpenTUI CLI renderer instance. */
  export interface CliRenderer {
    // Opaque type - we don't need the internals
  }

  /** Represents a keyboard event with key name, modifiers, and event type. */
  export class KeyEvent {
    name: string
    sequence: string
    ctrl: boolean
    shift: boolean
    meta: boolean
    option: boolean
    repeated?: boolean
    eventType: 'press' | 'release'
  }

  /** Creates an OpenTUI CLI renderer for alternate-screen terminal output. */
  export function createCliRenderer(options?: CliRendererConfig): Promise<CliRenderer>
}

declare module '@opentui/react' {
  import type { CliRenderer, KeyEvent } from '@opentui/core'
  import type { ReactNode } from 'react'

  /** Options for the useKeyboard hook (e.g. whether to listen for key release events). */
  export interface UseKeyboardOptions {
    release?: boolean
  }

  /** An OpenTUI React root that can render and unmount component trees. */
  export interface Root {
    render(element: ReactNode): void
    unmount(): void
  }

  /** Creates an OpenTUI React root from a CLI renderer for rendering component trees. */
  export function createRoot(renderer: CliRenderer): Root
  /** Registers a keyboard event handler for the current OpenTUI component. */
  export function useKeyboard(handler: (key: KeyEvent) => void, options?: UseKeyboardOptions): void
  /** Registers a terminal resize handler and returns the CLI renderer. */
  export function useOnResize(handler: (width: number, height: number) => void): CliRenderer
  /** Returns the current terminal dimensions (width and height in characters). */
  export function useTerminalDimensions(): { width: number; height: number }
}
