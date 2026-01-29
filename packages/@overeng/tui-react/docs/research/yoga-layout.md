# Yoga Layout Research

> Research document for flexbox layout with Yoga.

## Overview

[Yoga](https://yogalayout.dev/) is an embeddable layout system created by Meta (Facebook). It implements a subset of CSS Flexbox and is used in production by React Native.

**Key characteristics:**

- Written in C++ with bindings for many languages
- Implements CSS Flexbox subset
- High performance, deterministic layout
- Used by React Native, Litho, ComponentKit

## Why Yoga?

Yoga provides a **familiar layout model** (CSS Flexbox) that works the same across platforms:

- Share mental model with web developers
- Predictable, well-documented behavior
- Battle-tested in React Native (millions of apps)

## Core Concepts

### Nodes

Layout is computed on a tree of nodes:

```typescript
import Yoga from 'yoga-layout'

// Create nodes
const root = Yoga.Node.create()
const child1 = Yoga.Node.create()
const child2 = Yoga.Node.create()

// Build tree
root.insertChild(child1, 0)
root.insertChild(child2, 1)

// Configure layout
root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN)
root.setWidth(100)

child1.setHeight(50)
child2.setFlexGrow(1)

// Calculate layout
root.calculateLayout(100, undefined, Yoga.DIRECTION_LTR)

// Read computed values
const layout = child1.getComputedLayout()
// { left: 0, top: 0, width: 100, height: 50 }
```

### Flexbox Properties

Yoga supports most CSS Flexbox properties:

| Property          | Yoga API              | Values                                                                              |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `flex-direction`  | `setFlexDirection()`  | `ROW`, `COLUMN`, `ROW_REVERSE`, `COLUMN_REVERSE`                                    |
| `justify-content` | `setJustifyContent()` | `FLEX_START`, `CENTER`, `FLEX_END`, `SPACE_BETWEEN`, `SPACE_AROUND`, `SPACE_EVENLY` |
| `align-items`     | `setAlignItems()`     | `FLEX_START`, `CENTER`, `FLEX_END`, `STRETCH`, `BASELINE`                           |
| `align-self`      | `setAlignSelf()`      | Same as align-items                                                                 |
| `flex-wrap`       | `setFlexWrap()`       | `NO_WRAP`, `WRAP`, `WRAP_REVERSE`                                                   |
| `flex-grow`       | `setFlexGrow()`       | Number                                                                              |
| `flex-shrink`     | `setFlexShrink()`     | Number                                                                              |
| `flex-basis`      | `setFlexBasis()`      | Number or `AUTO`                                                                    |

### Box Model

```typescript
// Dimensions
node.setWidth(100)
node.setHeight(50)
node.setMinWidth(50)
node.setMaxWidth(200)

// Padding (inside)
node.setPadding(Yoga.EDGE_ALL, 10)
node.setPadding(Yoga.EDGE_LEFT, 5)
node.setPadding(Yoga.EDGE_TOP, 5)

// Margin (outside)
node.setMargin(Yoga.EDGE_ALL, 10)
node.setMargin(Yoga.EDGE_HORIZONTAL, 5)
node.setMargin(Yoga.EDGE_VERTICAL, 5)

// Border (affects layout but not rendered by Yoga)
node.setBorder(Yoga.EDGE_ALL, 1)
```

### Positioning

```typescript
// Relative (default) - participates in flex layout
node.setPositionType(Yoga.POSITION_TYPE_RELATIVE)

// Absolute - removed from flow, positioned relative to parent
node.setPositionType(Yoga.POSITION_TYPE_ABSOLUTE)
node.setPosition(Yoga.EDGE_LEFT, 10)
node.setPosition(Yoga.EDGE_TOP, 20)
```

## JavaScript Bindings

### yoga-layout (Official)

```bash
npm install yoga-layout
```

```typescript
import Yoga from 'yoga-layout'

const node = Yoga.Node.create()
node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW)
node.calculateLayout()
```

### yoga-wasm-web (WebAssembly)

Smaller bundle, async initialization:

```typescript
import { init } from 'yoga-wasm-web'

const Yoga = await init()
const node = Yoga.Node.create()
```

## Integration with React

Yoga pairs naturally with React reconcilers:

```typescript
// In host config
createInstance(type, props) {
  const node = Yoga.Node.create()

  // Apply layout props
  if (props.flexDirection) {
    node.setFlexDirection(flexDirectionMap[props.flexDirection])
  }
  if (props.padding !== undefined) {
    node.setPadding(Yoga.EDGE_ALL, props.padding)
  }
  // ... more props

  return { type, props, yogaNode: node, children: [] }
}

appendChild(parent, child) {
  parent.children.push(child)
  parent.yogaNode.insertChild(child.yogaNode, parent.yogaNode.getChildCount())
}

// Before rendering, calculate layout
root.yogaNode.calculateLayout(terminalWidth, undefined, Yoga.DIRECTION_LTR)

// Then read computed positions during render
const { left, top, width, height } = node.yogaNode.getComputedLayout()
```

## Terminal-Specific Considerations

### Character Grid

Terminals use a character grid, not pixels:

- Width = columns (characters)
- Height = rows (lines)

Yoga works fine with integer units - just treat columns as pixels.

### No Fractional Positioning

Terminal cells are discrete. Round layout values:

```typescript
const layout = node.getComputedLayout()
const x = Math.round(layout.left)
const y = Math.round(layout.top)
const width = Math.round(layout.width)
const height = Math.round(layout.height)
```

### Text Measurement

For text content, you need a custom measure function:

```typescript
import stringWidth from 'string-width'

const textNode = Yoga.Node.create()
textNode.setMeasureFunc((width, widthMode, height, heightMode) => {
  const text = getTextContent(textNode)
  const textWidth = stringWidth(text)

  // Simple: single line
  return { width: textWidth, height: 1 }

  // With wrapping: calculate lines needed
  if (widthMode === Yoga.MEASURE_MODE_AT_MOST && textWidth > width) {
    const lines = wrapText(text, width)
    return { width, height: lines.length }
  }

  return { width: textWidth, height: 1 }
})
```

### Performance

For CLI-scale UIs (< 100 nodes), Yoga is extremely fast:

- Layout calculation: < 1ms typically
- Memory: ~1KB per node

No need for optimization at CLI scale.

## Common Patterns

### Vertical Stack (Column)

```typescript
root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN)
// Children stack vertically
```

### Horizontal Row

```typescript
root.setFlexDirection(Yoga.FLEX_DIRECTION_ROW)
// Children arrange horizontally
```

### Fill Available Space

```typescript
child.setFlexGrow(1)
// Child expands to fill remaining space
```

### Fixed + Flexible

```typescript
// Header: fixed height
header.setHeight(3)

// Content: fills remaining
content.setFlexGrow(1)

// Footer: fixed height
footer.setHeight(2)
```

### Centering

```typescript
container.setJustifyContent(Yoga.JUSTIFY_CENTER) // Main axis
container.setAlignItems(Yoga.ALIGN_CENTER) // Cross axis
```

## Memory Management

Yoga nodes must be explicitly freed:

```typescript
// Create
const node = Yoga.Node.create()

// Use...

// Free when done
node.free()

// Or free entire tree
root.freeRecursive()
```

In a React reconciler, free nodes in `removeChild`:

```typescript
removeChild(parent, child) {
  parent.yogaNode.removeChild(child.yogaNode)
  child.yogaNode.freeRecursive()
}
```

## Limitations

### Not Supported

- CSS Grid
- `position: fixed` / `position: sticky`
- `z-index` (no stacking context)
- Percentages in some contexts
- `calc()`

### Terminal-Specific

- No sub-character positioning
- No overlapping (need separate overlay system)
- Text wrapping requires custom measure functions

## References

- [Yoga Documentation](https://yogalayout.dev/docs/about-yoga)
- [Yoga Playground](https://yogalayout.dev/playground)
- [Yoga GitHub](https://github.com/facebook/yoga)
- [npm: yoga-layout](https://www.npmjs.com/package/yoga-layout)
