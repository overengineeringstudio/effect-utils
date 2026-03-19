import type { Document } from './model/document.ts'
import type { Entry } from './model/entry.ts'
import type { Identifier } from './model/identifier.ts'
import type { Node } from './model/node.ts'
import type { Tag } from './model/tag.ts'
import type { Value } from './model/value.ts'
import type { Location, Token } from './parser/token.ts'

/** Stored location of a parsed KDL element */
export interface StoredLocation {
  readonly start: Location
  readonly end: Location
}

type KdlElement = Value | Identifier | Tag | Entry | Node | Document

const locations = new WeakMap<KdlElement, StoredLocation>()

/**
 * Get location information of the given parsed element.
 * Returns undefined if the element was not created by the parser
 * or if `storeLocations` was not enabled.
 */
export const getLocation = (element: KdlElement): StoredLocation | undefined =>
  locations.get(element)

export const storeLocation = (
  element: KdlElement,
  { start }: Token,
  { end }: Token,
): void => {
  locations.set(element, { start, end })
}
