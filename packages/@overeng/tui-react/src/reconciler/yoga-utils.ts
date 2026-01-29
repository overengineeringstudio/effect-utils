/**
 * Yoga layout utilities.
 *
 * Maps our component props to Yoga node configuration.
 */

import Yoga, {
  Align,
  Direction,
  FlexDirection,
  Gutter,
  Justify,
  Edge,
  type Node as YogaNode,
} from 'yoga-layout'

import type { BoxNodeProps } from './types.ts'

/** Create a new Yoga node */
export const createYogaNode = (): YogaNode => Yoga.Node.create()

/** Apply box props to a Yoga node */
// oxlint-disable-next-line overeng/named-args -- internal function with clear positional semantics
export const applyBoxProps = (node: YogaNode, props: BoxNodeProps): void => {
  // Flex direction
  if (props.flexDirection !== undefined) {
    node.setFlexDirection(props.flexDirection === 'row' ? FlexDirection.Row : FlexDirection.Column)
  }

  // Flex grow/shrink
  if (props.flexGrow !== undefined) {
    node.setFlexGrow(props.flexGrow)
  }
  if (props.flexShrink !== undefined) {
    node.setFlexShrink(props.flexShrink)
  }
  if (props.flexBasis !== undefined) {
    if (props.flexBasis === 'auto') {
      node.setFlexBasisAuto()
    } else {
      node.setFlexBasis(props.flexBasis)
    }
  }

  // Alignment
  if (props.alignItems !== undefined) {
    node.setAlignItems(mapAlign(props.alignItems))
  }
  if (props.alignSelf !== undefined) {
    node.setAlignSelf(mapAlignSelf(props.alignSelf))
  }
  if (props.justifyContent !== undefined) {
    node.setJustifyContent(mapJustify(props.justifyContent))
  }

  // Padding
  if (props.padding !== undefined) {
    node.setPadding(Edge.All, props.padding)
  }
  if (props.paddingTop !== undefined) {
    node.setPadding(Edge.Top, props.paddingTop)
  }
  if (props.paddingBottom !== undefined) {
    node.setPadding(Edge.Bottom, props.paddingBottom)
  }
  if (props.paddingLeft !== undefined) {
    node.setPadding(Edge.Left, props.paddingLeft)
  }
  if (props.paddingRight !== undefined) {
    node.setPadding(Edge.Right, props.paddingRight)
  }

  // Margin
  if (props.margin !== undefined) {
    node.setMargin(Edge.All, props.margin)
  }
  if (props.marginTop !== undefined) {
    node.setMargin(Edge.Top, props.marginTop)
  }
  if (props.marginBottom !== undefined) {
    node.setMargin(Edge.Bottom, props.marginBottom)
  }
  if (props.marginLeft !== undefined) {
    node.setMargin(Edge.Left, props.marginLeft)
  }
  if (props.marginRight !== undefined) {
    node.setMargin(Edge.Right, props.marginRight)
  }

  // Gap
  if (props.gap !== undefined) {
    node.setGap(Gutter.All, props.gap)
  }

  // Sizing
  if (props.width !== undefined) {
    if (typeof props.width === 'string' && props.width.endsWith('%')) {
      node.setWidthPercent(parseFloat(props.width))
    } else if (typeof props.width === 'number') {
      node.setWidth(props.width)
    }
  }
  if (props.height !== undefined) {
    node.setHeight(props.height)
  }
  if (props.minWidth !== undefined) {
    node.setMinWidth(props.minWidth)
  }
  if (props.minHeight !== undefined) {
    node.setMinHeight(props.minHeight)
  }
  if (props.maxWidth !== undefined) {
    node.setMaxWidth(props.maxWidth)
  }
  if (props.maxHeight !== undefined) {
    node.setMaxHeight(props.maxHeight)
  }
}

/** Map align items prop to Yoga enum */
const mapAlign = (align: NonNullable<BoxNodeProps['alignItems']>): Align => {
  switch (align) {
    case 'flex-start':
      return Align.FlexStart
    case 'center':
      return Align.Center
    case 'flex-end':
      return Align.FlexEnd
    case 'stretch':
      return Align.Stretch
  }
}

/** Map align self prop to Yoga enum */
const mapAlignSelf = (align: NonNullable<BoxNodeProps['alignSelf']>): Align => {
  switch (align) {
    case 'auto':
      return Align.Auto
    case 'flex-start':
      return Align.FlexStart
    case 'center':
      return Align.Center
    case 'flex-end':
      return Align.FlexEnd
    case 'stretch':
      return Align.Stretch
  }
}

/** Map justify content prop to Yoga enum */
const mapJustify = (justify: NonNullable<BoxNodeProps['justifyContent']>): Justify => {
  switch (justify) {
    case 'flex-start':
      return Justify.FlexStart
    case 'center':
      return Justify.Center
    case 'flex-end':
      return Justify.FlexEnd
    case 'space-between':
      return Justify.SpaceBetween
    case 'space-around':
      return Justify.SpaceAround
  }
}

/** Calculate layout for a tree starting at node */
// oxlint-disable-next-line overeng/named-args -- internal function with clear positional semantics
export const calculateLayout = (node: YogaNode, width: number): void => {
  node.calculateLayout(width, undefined, Direction.LTR)
}

/** Get computed layout for a node */
export const getLayout = (node: YogaNode) => ({
  left: node.getComputedLeft(),
  top: node.getComputedTop(),
  width: node.getComputedWidth(),
  height: node.getComputedHeight(),
})

/** Free a Yoga node and all its children */
export const freeYogaNode = (node: YogaNode): void => {
  // Free children first
  const childCount = node.getChildCount()
  for (let i = childCount - 1; i >= 0; i--) {
    const child = node.getChild(i)
    node.removeChild(child)
    freeYogaNode(child)
  }
  node.free()
}
