/**
 * Internal node types for the TUI reconciler.
 */

import type { Node as YogaNode } from 'yoga-layout'

import type { Color } from '@overeng/tui-core'

// =============================================================================
// Node Types
// =============================================================================

/** Base properties shared by all nodes */
interface BaseNode {
  /** Parent node (null for root) */
  parent: TuiElement | null
  /** Yoga layout node */
  yogaNode: YogaNode
}

/** Text style properties */
export interface TextStyle {
  color?: Color | undefined
  backgroundColor?: Color | undefined
  bold?: boolean | undefined
  dim?: boolean | undefined
  italic?: boolean | undefined
  underline?: boolean | undefined
  strikethrough?: boolean | undefined
  /** OSC 8 hyperlink URL (clickable in supported terminals) */
  href?: string | undefined
}

/** Box element - container with flexbox layout */
export interface TuiBoxElement extends BaseNode {
  type: 'tui-box'
  props: BoxNodeProps
  children: TuiNode[]
}

/** Text element - styled text content */
export interface TuiTextElement extends BaseNode {
  type: 'tui-text'
  props: TextNodeProps
  children: TuiNode[]
}

/** Raw text node - plain string content */
export interface TuiTextNode {
  type: 'tui-text-node'
  parent: TuiElement | null
  text: string
}

/** Static element - renders items to static region */
export interface TuiStaticElement extends BaseNode {
  type: 'tui-static'
  props: StaticNodeProps
  children: TuiNode[]
  /** Number of items that have been committed to static region */
  committedCount: number
}

/** Union of all element types */
export type TuiElement = TuiBoxElement | TuiTextElement | TuiStaticElement

/** Union of all node types */
export type TuiNode = TuiElement | TuiTextNode

// =============================================================================
// Props Types
// =============================================================================

/** Box component props (internal) */
export interface BoxNodeProps {
  // Layout
  flexDirection?: 'row' | 'column' | undefined
  flexGrow?: number | undefined
  flexShrink?: number | undefined
  flexBasis?: number | 'auto' | undefined
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | undefined
  justifyContent?:
    | 'flex-start'
    | 'center'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | undefined

  // Spacing
  padding?: number | undefined
  paddingTop?: number | undefined
  paddingBottom?: number | undefined
  paddingLeft?: number | undefined
  paddingRight?: number | undefined
  margin?: number | undefined
  marginTop?: number | undefined
  marginBottom?: number | undefined
  marginLeft?: number | undefined
  marginRight?: number | undefined
  gap?: number | undefined

  // Sizing
  width?: number | string | undefined
  height?: number | undefined
  minWidth?: number | undefined
  minHeight?: number | undefined
  maxWidth?: number | undefined
  maxHeight?: number | undefined

  // Styling
  backgroundColor?: Color | undefined
  extendBackground?: boolean | undefined
}

/** Text component props (internal) */
export interface TextNodeProps extends TextStyle {
  wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-middle' | undefined
}

/** Static component props (internal) */
export interface StaticNodeProps {
  // Items are handled specially - not stored as children
}

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if a node is a raw text node. */
export const isTextNode = (node: TuiNode): node is TuiTextNode => node.type === 'tui-text-node'

/** Type guard that checks if a node is an element (box, text, or static). */
export const isElement = (node: TuiNode): node is TuiElement =>
  node.type === 'tui-box' || node.type === 'tui-text' || node.type === 'tui-static'

/** Type guard that checks if a node is a box element. */
export const isBoxElement = (node: TuiNode): node is TuiBoxElement => node.type === 'tui-box'

/** Type guard that checks if a node is a text element. */
export const isTextElement = (node: TuiNode): node is TuiTextElement => node.type === 'tui-text'

/** Type guard that checks if a node is a static element. */
export const isStaticElement = (node: TuiNode): node is TuiStaticElement =>
  node.type === 'tui-static'
