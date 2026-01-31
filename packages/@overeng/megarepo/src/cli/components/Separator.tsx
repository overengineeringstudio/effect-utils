/**
 * Separator Component
 *
 * Horizontal separator line.
 */

import React from 'react'

import { Text } from '@overeng/tui-react'

import { icons } from './tokens.ts'

// =============================================================================
// Types
// =============================================================================

export interface SeparatorProps {
  /** Width of the separator (default: 40) */
  width?: number
}

// =============================================================================
// Component
// =============================================================================

/**
 * Separator - Horizontal line
 *
 * Renders a dim horizontal separator:
 * ```
 * ────────────────────────────────────────
 * ```
 *
 * @example
 * ```tsx
 * <Separator />
 * <Separator width={60} />
 * ```
 */
export const Separator = ({ width = 40 }: SeparatorProps) => (
  <Text dim>{icons.separator.repeat(width)}</Text>
)
