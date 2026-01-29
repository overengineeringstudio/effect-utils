/**
 * Type declarations for optional OpenTUI dependencies.
 *
 * OpenTUI is an optional dependency that only works in Bun environments.
 * These declarations allow TypeScript to compile without the packages installed.
 *
 * When OpenTUI is installed, these types will be overridden by the actual package types.
 */

declare module '@opentui/core' {
  export interface CliRendererOptions {
    exitOnCtrlC?: boolean
  }

  export interface CliRenderer {
    // Opaque type - we don't need the internals
  }

  export function createCliRenderer(options?: CliRendererOptions): Promise<CliRenderer>
}

declare module '@opentui/react' {
  import type { ReactNode } from 'react'

  export interface OpenTuiKeyEvent {
    name: string
    sequence: string
    ctrl: boolean
    shift: boolean
    meta: boolean
    option: boolean
    repeated: boolean
    eventType: 'press' | 'release'
  }

  export interface UseKeyboardOptions {
    release?: boolean
  }

  export interface OpenTuiRoot {
    render(element: ReactNode): void
    unmount(): void
  }

  export function createRoot(renderer: unknown): OpenTuiRoot
  export function useKeyboard(
    handler: (key: OpenTuiKeyEvent) => void,
    options?: UseKeyboardOptions,
  ): void
  export function useOnResize(handler: (width: number, height: number) => void): void
  export function useTerminalDimensions(): { width: number; height: number }
}
