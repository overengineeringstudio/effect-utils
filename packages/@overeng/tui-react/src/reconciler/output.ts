/**
 * Output renderer - converts the TUI tree to terminal lines.
 *
 * This module takes a tree of TuiNodes with computed Yoga layouts
 * and renders them to an array of strings for terminal output.
 */

import stringWidth from 'string-width'

import {
  bold,
  dim,
  italic,
  underline,
  strikethrough,
  hyperlink,
  fg,
  bg,
  bgCode,
  bgReset,
  clearToEndOfLine,
  type Color,
} from '@overeng/tui-core'

import type { TuiNode, TuiElement, TextStyle } from './types.ts'
import { isTextNode, isBoxElement, isTextElement, isStaticElement } from './types.ts'
import { getLayout } from './yoga-utils.ts'

/** Box styling context passed down to children */
interface BoxStyle {
  backgroundColor?: Color | undefined
  extendBackground?: boolean | undefined
}

/** Output buffer - 2D array of characters with styles */
interface OutputBuffer {
  lines: string[][]
  width: number
  height: number
}

/** Create an empty output buffer */
const createBuffer = ({ width, height }: { width: number; height: number }): OutputBuffer => ({
  lines: Array.from({ length: height }, () => Array.from({ length: width }, () => ' ')),
  width,
  height,
})

/** Write text to buffer at position */
const writeToBuffer = ({
  buffer,
  x,
  y,
  text,
  maxWidth,
}: {
  buffer: OutputBuffer
  x: number
  y: number
  text: string
  maxWidth: number
}): void => {
  if (y < 0 || y >= buffer.height) return

  let col = Math.floor(x)
  const chars = [...text] // Handle Unicode properly

  for (const char of chars) {
    if (col >= buffer.width || col >= x + maxWidth) break
    if (col >= 0) {
      buffer.lines[y]![col] = char
    }
    col += stringWidth(char)
  }
}

/** Collect all text content from a text element and its children */
const collectTextContent = (node: TuiNode): string => {
  if (isTextNode(node)) {
    return node.text
  }
  if (isTextElement(node)) {
    return node.children.map(collectTextContent).join('')
  }
  return ''
}

/** Apply text styles to a string */
const applyStyles = ({ text, style }: { text: string; style: TextStyle }): string => {
  let result = text

  if (style.bold) result = bold(result)
  if (style.dim) result = dim(result)
  if (style.italic) result = italic(result)
  if (style.underline) result = underline(result)
  if (style.strikethrough) result = strikethrough(result)
  if (style.color) result = fg({ color: style.color, text: result })
  if (style.backgroundColor) result = bg({ color: style.backgroundColor, text: result })
  if (style.href) {
    result = underline(result)
    result = hyperlink({ url: style.href, text: result })
  }

  return result
}

/** Render a node and its children to the buffer */
const renderNode = ({
  node,
  buffer,
  parentX,
  parentY,
  inheritedStyle,
}: {
  node: TuiNode
  buffer: OutputBuffer
  parentX: number
  parentY: number
  inheritedStyle: TextStyle
}): void => {
  if (isTextNode(node)) {
    // Raw text nodes are rendered by their parent text element
    return
  }

  if (isStaticElement(node)) {
    // Static elements are handled separately - they don't render to the main buffer
    return
  }

  const layout = getLayout(node.yogaNode)
  const x = parentX + layout.left
  const y = parentY + layout.top

  if (isTextElement(node)) {
    // Merge styles
    const style: TextStyle = { ...inheritedStyle, ...node.props }

    // Collect text content
    const text = collectTextContent(node)
    const styledText = applyStyles({ text, style })

    // Write to buffer
    const row = Math.floor(y)
    if (row >= 0 && row < buffer.height) {
      writeToBuffer({ buffer, x, y: row, text: styledText, maxWidth: layout.width })
    }
    return
  }

  if (isBoxElement(node)) {
    // Render children
    for (const child of node.children) {
      renderNode({ node: child, buffer, parentX: x, parentY: y, inheritedStyle })
    }
  }
}

/**
 * Render a TUI tree to an array of lines.
 *
 * @param root - The root node of the tree (should have layout calculated)
 * @param width - Terminal width
 * @returns Array of strings, one per line
 */
export const renderToLines = ({ root, width }: { root: TuiElement; width: number }): string[] => {
  const layout = getLayout(root.yogaNode)
  const height = Math.ceil(layout.height)

  if (height === 0) {
    return []
  }

  // Create buffer
  const buffer = createBuffer({ width, height })

  // Render tree to buffer
  renderNode({ node: root, buffer, parentX: 0, parentY: 0, inheritedStyle: {} })

  // Convert buffer to lines, trimming trailing spaces
  return buffer.lines.map((line) => line.join('').trimEnd())
}

/**
 * Render a single element to lines using the simple (non-Yoga) approach.
 * Used for static content where elements are rendered individually.
 */
const renderElementSimple = ({
  element,
  width,
}: {
  element: TuiElement
  width: number
}): string[] => {
  const lines: string[] = []

  const render = ({
    node,
    style,
    boxStyle,
  }: {
    node: TuiNode
    style: TextStyle
    boxStyle: BoxStyle
  }): void => {
    if (isTextNode(node)) {
      return // Handled by parent
    }

    if (isStaticElement(node)) {
      return // Static handled separately
    }

    if (isTextElement(node)) {
      const mergedStyle = { ...style, ...node.props }
      const text = collectTextContent(node)
      const styledText = applyStyles({ text, style: mergedStyle })
      lines.push(applyBoxStyle({ line: styledText, boxStyle, terminalWidth: width }))
      return
    }

    if (isBoxElement(node)) {
      const isRow = node.props.flexDirection === 'row'

      // Create box style context for children
      const newBoxStyle: BoxStyle = node.props.backgroundColor
        ? {
            backgroundColor: node.props.backgroundColor,
            extendBackground: node.props.extendBackground,
          }
        : boxStyle

      if (isRow) {
        // For row layout, collect all children on one line
        const parts: string[] = []
        for (const child of node.children) {
          if (isTextElement(child) || isTextNode(child)) {
            const mergedStyle = isTextElement(child) ? { ...style, ...child.props } : style
            const text = isTextNode(child) ? child.text : collectTextContent(child)
            parts.push(applyStyles({ text, style: mergedStyle }))
          }
        }
        if (parts.length > 0) {
          lines.push(
            applyBoxStyle({ line: parts.join(''), boxStyle: newBoxStyle, terminalWidth: width }),
          )
        }
        // Also render any nested boxes
        for (const child of node.children) {
          if (isBoxElement(child)) {
            render({ node: child, style, boxStyle: newBoxStyle })
          }
        }
      } else {
        // Column layout - render each child on its own line(s)
        for (const child of node.children) {
          render({ node: child, style, boxStyle: newBoxStyle })
        }
      }
    }
  }

  render({ node: element, style: {}, boxStyle: {} })
  return lines
}

/**
 * Extract static items from a tree.
 *
 * Finds all Static elements and returns their rendered content
 * along with the count of items that have been committed.
 */
export const extractStaticContent = ({
  root,
  width,
}: {
  root: TuiElement
  width: number
}): { lines: string[]; newItemCount: number; element: TuiElement | null } => {
  // Find the first static element
  const findStatic = (node: TuiNode): TuiElement | null => {
    if (isStaticElement(node)) {
      return node
    }
    if (isBoxElement(node) || isTextElement(node)) {
      for (const child of node.children) {
        const found = findStatic(child)
        if (found) return found
      }
    }
    return null
  }

  const staticElement = findStatic(root)
  if (!staticElement || !isStaticElement(staticElement)) {
    return { lines: [], newItemCount: 0, element: null }
  }

  // Render the static element's children that haven't been committed yet
  const uncommittedChildren = staticElement.children.slice(staticElement.committedCount)
  const lines: string[] = []

  for (const child of uncommittedChildren) {
    if (!isTextNode(child)) {
      // Use renderTreeSimple which doesn't rely on Yoga layout measurements
      // This is necessary because standalone text elements have height=0 in Yoga
      // (text content isn't measured by Yoga, only by the terminal output)
      const childLines = renderElementSimple({ element: child, width })
      lines.push(...childLines)
    }
  }

  return {
    lines,
    newItemCount: staticElement.children.length,
    element: staticElement,
  }
}

/**
 * Apply box background styling to a line
 */
const applyBoxStyle = ({
  line,
  boxStyle,
  terminalWidth,
}: {
  line: string
  boxStyle: BoxStyle
  terminalWidth: number
}): string => {
  if (!boxStyle.backgroundColor) {
    return line
  }

  let result = line

  // Apply background color
  const bgStart = bgCode(boxStyle.backgroundColor)
  const bgEnd = bgReset()

  if (boxStyle.extendBackground) {
    // Pad to terminal width and add clear-to-EOL for full-width background
    const lineWidth = stringWidth(result)
    const padding = Math.max(0, terminalWidth - lineWidth)
    result = `${bgStart}${result}${' '.repeat(padding)}${clearToEndOfLine()}${bgEnd}`
  } else {
    result = `${bgStart}${result}${bgEnd}`
  }

  return result
}

/**
 * Squash consecutive text nodes and text elements into single lines.
 *
 * This is a simple approach - for more complex layouts, we'd need
 * proper 2D buffer rendering.
 */
export const renderTreeSimple = ({
  root,
  width,
  maxLines,
}: {
  root: TuiElement
  width: number
  maxLines?: number
}): string[] => {
  const lines: string[] = []

  const render = ({
    node,
    style,
    indent,
    boxStyle,
  }: {
    node: TuiNode
    style: TextStyle
    indent: number
    boxStyle: BoxStyle
  }): void => {
    if (isTextNode(node)) {
      return // Handled by parent
    }

    if (isStaticElement(node)) {
      return // Static handled separately
    }

    if (maxLines !== undefined && lines.length >= maxLines) return

    if (isTextElement(node)) {
      const mergedStyle = { ...style, ...node.props }
      const text = collectTextContent(node)
      const styledText = applyStyles({ text, style: mergedStyle })
      const indentStr = ' '.repeat(indent)
      const line = indentStr + styledText
      lines.push(applyBoxStyle({ line, boxStyle, terminalWidth: width }))
      return
    }

    if (isBoxElement(node)) {
      const isRow = node.props.flexDirection === 'row'
      const paddingLeft = node.props.paddingLeft ?? node.props.padding ?? 0
      const newIndent = indent + paddingLeft

      // Yoga height clipping: track lines produced by this box and stop
      // when the box exceeds its yoga-computed height.
      const computedHeight = Math.ceil(getLayout(node.yogaNode).height)
      const startLineCount = lines.length
      const boxFull = (): boolean =>
        computedHeight > 0 && lines.length - startLineCount >= computedHeight

      // Create box style context for children
      const newBoxStyle: BoxStyle = node.props.backgroundColor
        ? {
            backgroundColor: node.props.backgroundColor,
            extendBackground: node.props.extendBackground,
          }
        : boxStyle

      if (isRow) {
        // For row layout, collect all children on one line
        const parts: string[] = []
        for (const child of node.children) {
          if (isTextElement(child) || isTextNode(child)) {
            const mergedStyle = isTextElement(child) ? { ...style, ...child.props } : style
            const text = isTextNode(child) ? child.text : collectTextContent(child)
            parts.push(applyStyles({ text, style: mergedStyle }))
          }
        }
        if (parts.length > 0) {
          const indentStr = ' '.repeat(newIndent)
          const line = indentStr + parts.join('')
          lines.push(applyBoxStyle({ line, boxStyle: newBoxStyle, terminalWidth: width }))
        }
        // Also render any nested boxes
        for (const child of node.children) {
          if (maxLines !== undefined && lines.length >= maxLines) break
          if (boxFull()) break
          if (isBoxElement(child)) {
            render({ node: child, style, indent: newIndent, boxStyle: newBoxStyle })
          }
        }
      } else {
        // Column layout - render each child on its own line(s)
        for (const child of node.children) {
          if (maxLines !== undefined && lines.length >= maxLines) break
          if (boxFull()) break
          render({ node: child, style, indent: newIndent, boxStyle: newBoxStyle })
        }
      }

      // Hard clip: if a child produced more lines than yoga allocated
      while (computedHeight > 0 && lines.length - startLineCount > computedHeight) {
        lines.pop()
      }
    }
  }

  render({ node: root, style: {}, indent: 0, boxStyle: {} })
  return lines
}
