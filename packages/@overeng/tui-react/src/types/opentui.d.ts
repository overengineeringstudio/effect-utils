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
  export interface CliRendererConfig {
    exitOnCtrlC?: boolean
  }

  export interface CliRenderer {
    // Opaque type - we don't need the internals
  }

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

  export function createCliRenderer(options?: CliRendererConfig): Promise<CliRenderer>
}

declare module '@opentui/react' {
  import type { ReactNode } from 'react'
  import type { CliRenderer, KeyEvent } from '@opentui/core'

  export interface UseKeyboardOptions {
    release?: boolean
  }

  export interface Root {
    render(element: ReactNode): void
    unmount(): void
  }

  export function createRoot(renderer: CliRenderer): Root
  export function useKeyboard(handler: (key: KeyEvent) => void, options?: UseKeyboardOptions): void
  export function useOnResize(handler: (width: number, height: number) => void): CliRenderer
  export function useTerminalDimensions(): { width: number; height: number }
}
