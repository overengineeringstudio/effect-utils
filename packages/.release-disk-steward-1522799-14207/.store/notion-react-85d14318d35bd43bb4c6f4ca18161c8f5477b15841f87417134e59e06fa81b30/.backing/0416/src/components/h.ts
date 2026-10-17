import { createElement, type ReactElement, type ReactNode } from 'react'

/**
 * Emit a Notion host element by tag name, bypassing JSX's ambient
 * `IntrinsicElements` check. The reconciler's host-config knows how to
 * project each Notion block type, so we skip TypeScript's DOM-element
 * typing that `@types/react` injects globally.
 */
export const h = (
  type: string,
  props?: Record<string, unknown> | null,
  children?: ReactNode,
): ReactElement =>
  children === undefined
    ? createElement(type, props as Record<string, unknown> | null)
    : createElement(type, props as Record<string, unknown> | null, children)
